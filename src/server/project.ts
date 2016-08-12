/// <reference path="..\services\services.ts" />
/// <reference path="utilities.ts"/>
/// <reference path="scriptInfo.ts"/>
/// <reference path="lsHost.ts"/>
/// <reference path="typingsCache.ts"/>

namespace ts.server {

    export enum ProjectKind {
        Inferred,
        Configured,
        External
    }

    function remove<T>(items: T[], item: T) {
        const index = items.indexOf(item);
        if (index >= 0) {
            items.splice(index, 1);
        }
    }

    export abstract class Project {
        private rootFiles: ScriptInfo[] = [];
        private rootFilesMap: FileMap<ScriptInfo> = createFileMap<ScriptInfo>();
        private lsHost: ServerLanguageServiceHost;
        private program: ts.Program;

        private languageService: LanguageService;
        /**
         * Set of files that was returned from the last call to getChangesSinceVersion.
         */
        private lastReportedFileNames: Map<string>;
        /**
         * Last version that was reported.
         */
        private lastReportedVersion = 0;
        /**
         * Current project structure version.
         * This property is changed in 'updateGraph' based on the set of files in program
         */
        private projectStructureVersion = 0;
        /**
         * Current version of the project state. It is changed when:
         * - new root file was added/removed
         * - edit happen in some file that is currently included in the project.
         * This property is different from projectStructureVersion since in most cases edits don't affect set of files in the project
         */
        private projectStateVersion = 0;

        private typingFiles: string[];

        constructor(
            readonly projectKind: ProjectKind,
            readonly projectService: ProjectService,
            private documentRegistry: ts.DocumentRegistry,
            hasExplicitListOfFiles: boolean,
            public languageServiceEnabled: boolean,
            private compilerOptions: CompilerOptions) {

            if (!this.compilerOptions) {
                this.compilerOptions = ts.getDefaultCompilerOptions();
                this.compilerOptions.allowNonTsExtensions = true;
                this.compilerOptions.allowJs = true;
            }
            else if (hasExplicitListOfFiles) {
                // If files are listed explicitly, allow all extensions
                this.compilerOptions.allowNonTsExtensions = true;
            }

            if (languageServiceEnabled) {
                this.enableLanguageService();
            }
            else {
                this.disableLanguageService();
            }
            this.markAsDirty();
        }

        getLanguageService(ensureSynchronized = true): LanguageService {
            if (ensureSynchronized) {
                this.updateGraph();
            }
            return this.languageService;
        }

        getProjectVersion() {
            return this.projectStateVersion.toString();
        }

        enableLanguageService() {
            const lsHost = new LSHost(this.projectService.host, this, this.projectService.cancellationToken);
            lsHost.setCompilationSettings(this.compilerOptions);
            this.languageService = ts.createLanguageService(lsHost, this.documentRegistry);

            this.lsHost = lsHost;
            this.languageServiceEnabled = true;
        }

        disableLanguageService() {
            this.languageService = nullLanguageService;
            this.lsHost = nullLanguageServiceHost;
            this.languageServiceEnabled = false;
        }

        abstract getProjectName(): string;

        close() {
            if (this.program) {
                // if we have a program - release all files that are enlisted in program
                for (const f of this.program.getSourceFiles()) {
                    const info = this.projectService.getScriptInfo(f.fileName);
                    info.detachFromProject(this);
                }
            }
            else {
                // release all root files
                for (const root of this.rootFiles) {
                    root.detachFromProject(this);
                }
            }
            this.rootFiles = undefined;
            this.rootFilesMap = undefined;
            this.program = undefined;

            // signal language service to release source files acquired from document registry
            this.languageService.dispose();
        }

        getCompilerOptions() {
            return this.compilerOptions;
        }

        hasRoots() {
            return this.rootFiles && this.rootFiles.length > 0;
        }

        getRootFiles() {
            return this.rootFiles && this.rootFiles.map(info => info.fileName);
        }

        getRootFilesLSHost() {
            const result: string[] = [];
            if (this.rootFiles) {
                for (const f of this.rootFiles) {
                    result.push(f.fileName);
                }
                if (this.typingFiles) {
                    for (const f of this.typingFiles) {
                        result.push(f);
                    }
                }
            }
            return result;
        }

        getRootScriptInfos() {
            return this.rootFiles;
        }

        getFileNames() {
            if (!this.program) {
                return [];
            }

            if (!this.languageServiceEnabled) {
                // if language service is disabled assume that all files in program are root files + default library
                let rootFiles = this.getRootFiles();
                if (this.compilerOptions) {
                    const defaultLibrary = getDefaultLibFilePath(this.compilerOptions);
                    if (defaultLibrary) {
                        (rootFiles || (rootFiles = [])).push(asNormalizedPath(defaultLibrary));
                    }
                }
                return rootFiles;
            }
            const sourceFiles = this.program.getSourceFiles();
            return sourceFiles.map(sourceFile => asNormalizedPath(sourceFile.fileName));
        }

        containsScriptInfo(info: ScriptInfo): boolean {
            return this.isRoot(info) || (this.program && this.program.getSourceFileByPath(info.path) !== undefined);
        }

        containsFile(filename: NormalizedPath, requireOpen?: boolean) {
            const info = this.projectService.getScriptInfoForNormalizedPath(filename);
            if (info && (info.isOpen || !requireOpen)) {
                return this.containsScriptInfo(info);
            }
        }

        isRoot(info: ScriptInfo) {
            return this.rootFilesMap && this.rootFilesMap.contains(info.path);
        }

        // add a root file to project
        addRoot(info: ScriptInfo) {
            if (!this.isRoot(info)) {
                this.rootFiles.push(info);
                this.rootFilesMap.set(info.path, info);
                info.attachToProject(this);

                this.markAsDirty();
            }
        }

        removeFile(info: ScriptInfo, detachFromProject = true) {
            this.removeRootFileIfNecessary(info);
            this.lsHost.notifyFileRemoved(info);

            if (detachFromProject) {
                info.detachFromProject(this);
            }

            this.markAsDirty();
        }

        markAsDirty() {
            this.projectStateVersion++;
        }

        /**
         * Updates set of files that contribute to this project
         * @returns: true if set of files in the project stays the same and false - otherwise.
         */
        updateGraph(): boolean {
            if (!this.languageServiceEnabled) {
                return true;
            }
            const hasChanges = this.updateGraphWorker();
            if (hasChanges) {
                if (this.setTypings(this.projectService.typingsCache.getTypingsForProject(this))) {
                    this.updateGraphWorker();
                }
                this.projectStructureVersion++;
            }
            return !hasChanges;
        }

        setTypings(typings: string[]): boolean {
            if (typings === this.typingFiles) {
                return false;
            }
            this.typingFiles = typings;
            this.markAsDirty();
            return true;
        }

        private updateGraphWorker() {
            const oldProgram = this.program;
            this.program = this.languageService.getProgram();

            let hasChanges = false;
            // bump up the version if
            // - oldProgram is not set - this is a first time updateGraph is called
            // - newProgram is different from the old program and structure of the old program was not reused.
            if (!oldProgram || (this.program !== oldProgram && !oldProgram.structureIsReused)) {
                hasChanges = true;
                if (oldProgram) {
                    for (const f of oldProgram.getSourceFiles()) {
                        if (this.program.getSourceFileByPath(f.path)) {
                            continue;
                        }
                        // new program does not contain this file - detach it from the project
                        const scriptInfoToDetach = this.projectService.getScriptInfo(f.fileName);
                        if (scriptInfoToDetach) {
                            scriptInfoToDetach.detachFromProject(this);
                        }
                    }
                }
            }
            return hasChanges;
        }

        getScriptInfoLSHost(fileName: string) {
            const scriptInfo = this.projectService.getOrCreateScriptInfo(fileName, /*openedByClient*/ false);
            if (scriptInfo) {
                scriptInfo.attachToProject(this);
            }
            return scriptInfo;
        }

        getScriptInfoForNormalizedPath(fileName: NormalizedPath) {
            const scriptInfo = this.projectService.getOrCreateScriptInfoForNormalizedPath(fileName, /*openedByClient*/ false);
            Debug.assert(!scriptInfo || scriptInfo.isAttached(this));
            return scriptInfo;
        }

        getScriptInfo(uncheckedFileName: string) {
            return this.getScriptInfoForNormalizedPath(toNormalizedPath(uncheckedFileName));
        }

        filesToString() {
            if (!this.program) {
                return "";
            }
            let strBuilder = "";
            for (const file of this.program.getSourceFiles()) {
                strBuilder += `${file.fileName}\n`;
            }
            return strBuilder;
        }

        setCompilerOptions(compilerOptions: CompilerOptions) {
            if (compilerOptions) {
                if (this.projectKind === ProjectKind.Inferred) {
                    compilerOptions.allowJs = true;
                }
                compilerOptions.allowNonTsExtensions = true;
                this.compilerOptions = compilerOptions;
                this.lsHost.setCompilationSettings(compilerOptions);

                this.markAsDirty();
            }
        }

        reloadScript(filename: NormalizedPath): boolean {
            const script = this.projectService.getScriptInfoForNormalizedPath(filename);
            if (script) {
                Debug.assert(script.isAttached(this));
                script.reloadFromFile();
                return true;
            }
            return false;
        }

        getChangesSinceVersion(lastKnownVersion?: number): protocol.ProjectFiles {
            this.updateGraph();

            const info = {
                projectName: this.getProjectName(),
                version: this.projectStructureVersion,
                isInferred: this.projectKind === ProjectKind.Inferred,
                options: this.getCompilerOptions()
            };
            // check if requested version is the same that we have reported last time
            if (this.lastReportedFileNames && lastKnownVersion === this.lastReportedVersion) {
                // if current structure version is the same - return info witout any changes
                if (this.projectStructureVersion == this.lastReportedVersion) {
                    return { info };
                }
                // compute and return the difference
                const lastReportedFileNames = this.lastReportedFileNames;
                const currentFiles = arrayToMap(this.getFileNames(), x => x);

                const added: string[] = [];
                const removed: string[] = [];
                for (const id in currentFiles) {
                    if (hasProperty(currentFiles, id) && !hasProperty(lastReportedFileNames, id)) {
                        added.push(id);
                    }
                }
                for (const id in lastReportedFileNames) {
                    if (hasProperty(lastReportedFileNames, id) && !hasProperty(currentFiles, id)) {
                        removed.push(id);
                    }
                }
                this.lastReportedFileNames = currentFiles;

                this.lastReportedFileNames = currentFiles;
                this.lastReportedVersion = this.projectStructureVersion;
                return { info, changes: { added, removed } };
            }
            else {
                // unknown version - return everything
                const projectFileNames = this.getFileNames();
                this.lastReportedFileNames = arrayToMap(projectFileNames, x => x);
                this.lastReportedVersion = this.projectStructureVersion;
                return { info, files: projectFileNames };
            }
        }

        // remove a root file from project
        private removeRootFileIfNecessary(info: ScriptInfo): void {
            if (this.isRoot(info)) {
                remove(this.rootFiles, info);
                this.rootFilesMap.remove(info.path);
            }
        }
    }

    export class InferredProject extends Project {

        private static NextId = 1;

        /**
         * Unique name that identifies this particular inferred project
         */
        private readonly inferredProjectName: string;

        // Used to keep track of what directories are watched for this project
        directoriesWatchedForTsconfig: string[] = [];

        constructor(projectService: ProjectService, documentRegistry: ts.DocumentRegistry, languageServiceEnabled: boolean, compilerOptions: CompilerOptions) {
            super(ProjectKind.Inferred,
                projectService,
                documentRegistry,
                /*files*/ undefined,
                languageServiceEnabled,
                compilerOptions);

            this.inferredProjectName = makeInferredProjectName(InferredProject.NextId);
            InferredProject.NextId++;
        }

        getProjectName() {
            return this.inferredProjectName;
        }

        close() {
            super.close();

            for (const directory of this.directoriesWatchedForTsconfig) {
                this.projectService.stopWatchingDirectory(directory);
            }
        }
    }

    export class ConfiguredProject extends Project {
        private projectFileWatcher: FileWatcher;
        private directoryWatcher: FileWatcher;
        private directoriesWatchedForWildcards: Map<FileWatcher>;
        /** Used for configured projects which may have multiple open roots */
        openRefCount = 0;

        constructor(readonly configFileName: NormalizedPath,
            projectService: ProjectService,
            documentRegistry: ts.DocumentRegistry,
            hasExplicitListOfFiles: boolean,
            compilerOptions: CompilerOptions,
            private typingOptions: TypingOptions,
            private wildcardDirectories: Map<WatchDirectoryFlags>,
            languageServiceEnabled: boolean) {
            super(ProjectKind.Configured, projectService, documentRegistry, hasExplicitListOfFiles, languageServiceEnabled, compilerOptions);
        }

        getTypingOptions() {
            return this.typingOptions;
        }

        getProjectName() {
            return this.configFileName;
        }

        watchConfigFile(callback: (project: ConfiguredProject) => void) {
            this.projectFileWatcher = this.projectService.host.watchFile(this.configFileName, _ => callback(this));
        }

        watchConfigDirectory(callback: (project: ConfiguredProject, path: string) => void) {
            if (this.directoryWatcher) {
                return;
            }

            const directoryToWatch = getDirectoryPath(this.configFileName);
            this.projectService.logger.info(`Add recursive watcher for: ${directoryToWatch}`);
            this.directoryWatcher = this.projectService.host.watchDirectory(directoryToWatch, path => callback(this, path), /*recursive*/ true);
        }

        watchWildcards(callback: (project: ConfiguredProject, path: string) => void) {
            if (!this.wildcardDirectories) {
                return;
            }
            const configDirectoryPath = getDirectoryPath(this.configFileName);
            this.directoriesWatchedForWildcards = reduceProperties(this.wildcardDirectories, (watchers, flag, directory) => {
                if (comparePaths(configDirectoryPath, directory, ".", !this.projectService.host.useCaseSensitiveFileNames) !== Comparison.EqualTo) {
                    const recursive = (flag & WatchDirectoryFlags.Recursive) !== 0;
                    this.projectService.logger.info(`Add ${recursive ? "recursive " : ""}watcher for: ${directory}`);
                    watchers[directory] = this.projectService.host.watchDirectory(
                        directory,
                        path => callback(this, path),
                        recursive
                    );
                }
                return watchers;
            }, <Map<FileWatcher>>{});
        }

        stopWatchingDirectory() {
            if (this.directoryWatcher) {
                this.directoryWatcher.close();
                this.directoryWatcher = undefined;
            }
        }

        close() {
            super.close();

            if (this.projectFileWatcher) {
                this.projectFileWatcher.close();
            }

            forEachValue(this.directoriesWatchedForWildcards, watcher => { watcher.close(); });
            this.directoriesWatchedForWildcards = undefined;

            this.stopWatchingDirectory();
        }

        addOpenRef() {
            this.openRefCount++;
        }

        deleteOpenRef() {
            this.openRefCount--;
            return this.openRefCount;
        }
    }

    export class ExternalProject extends Project {
        constructor(readonly externalProjectName: string,
            projectService: ProjectService,
            documentRegistry: ts.DocumentRegistry,
            compilerOptions: CompilerOptions,
            languageServiceEnabled: boolean) {
            super(ProjectKind.External, projectService, documentRegistry, /*hasExplicitListOfFiles*/ true, languageServiceEnabled, compilerOptions);
        }

        getProjectName() {
            return this.externalProjectName;
        }
    }
}