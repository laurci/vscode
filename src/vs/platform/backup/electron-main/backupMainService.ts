/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import * as fs from 'fs';
import { isEqual } from 'vs/base/common/extpath';
import { Schemas } from 'vs/base/common/network';
import { join } from 'vs/base/common/path';
import { isLinux } from 'vs/base/common/platform';
import { extUriBiasedIgnorePathCase } from 'vs/base/common/resources';
import { Promises, RimRafMode } from 'vs/base/node/pfs';
import { IBackupMainService } from 'vs/platform/backup/electron-main/backup';
import { ISerializedBackupWorkspaces, IEmptyWindowBackupInfo, isEmptyWindowBackupInfo, deserializeWorkspaceInfos, deserializeFolderInfos, ISerializedWorkspaceBackupInfo, ISerializedFolderBackupInfo, ISerializedEmptyWindowBackupInfo, ILegacySerializedBackupWorkspaces } from 'vs/platform/backup/node/backup';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IEnvironmentMainService } from 'vs/platform/environment/electron-main/environmentMainService';
import { IStateMainService } from 'vs/platform/state/electron-main/state';
import { HotExitConfiguration, IFilesConfiguration } from 'vs/platform/files/common/files';
import { ILogService } from 'vs/platform/log/common/log';
import { IFolderBackupInfo, isFolderBackupInfo, IWorkspaceBackupInfo } from 'vs/platform/backup/common/backup';
import { isWorkspaceIdentifier } from 'vs/platform/workspace/common/workspace';
import { createEmptyWorkspaceIdentifier } from 'vs/platform/workspaces/node/workspaces';

export class BackupMainService implements IBackupMainService {

	declare readonly _serviceBrand: undefined;

	private static readonly backupWorkspacesMetadataStorageKey = 'backupWorkspaces';

	protected backupHome = this.environmentMainService.backupHome;

	private workspaces: IWorkspaceBackupInfo[] = [];
	private folders: IFolderBackupInfo[] = [];
	private emptyWindows: IEmptyWindowBackupInfo[] = [];

	// Comparers for paths and resources that will
	// - ignore path casing on Windows/macOS
	// - respect path casing on Linux
	private readonly backupUriComparer = extUriBiasedIgnorePathCase;
	private readonly backupPathComparer = { isEqual: (pathA: string, pathB: string) => isEqual(pathA, pathB, !isLinux) };

	constructor(
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IStateMainService private readonly stateMainService: IStateMainService
	) {
	}

	async initialize(): Promise<void> {

		// read backup workspaces
		const serializedBackupWorkspaces = await this.initializeAndMigrateBackupWorkspacesMetadata();

		// validate empty workspaces backups first
		this.emptyWindows = await this.validateEmptyWorkspaces(serializedBackupWorkspaces.emptyWindows);

		// validate workspace backups
		this.workspaces = await this.validateWorkspaces(deserializeWorkspaceInfos(serializedBackupWorkspaces));

		// validate folder backups
		this.folders = await this.validateFolders(deserializeFolderInfos(serializedBackupWorkspaces));

		// store metadata in case some workspaces or folders have been removed
		this.storeWorkspacesMetadata();
	}

	private async initializeAndMigrateBackupWorkspacesMetadata(): Promise<ISerializedBackupWorkspaces> {
		let serializedBackupWorkspaces = this.stateMainService.getItem<ISerializedBackupWorkspaces>(BackupMainService.backupWorkspacesMetadataStorageKey);
		if (!serializedBackupWorkspaces) {
			try {
				//TODO@bpasero remove after a while
				const legacyBackupWorkspacesPath = join(this.backupHome, 'workspaces.json');
				const legacyBackupWorkspaces = await Promises.readFile(legacyBackupWorkspacesPath, 'utf8');

				await Promises.unlink(legacyBackupWorkspacesPath);

				const legacySserializedBackupWorkspaces = JSON.parse(legacyBackupWorkspaces) as ILegacySerializedBackupWorkspaces;
				serializedBackupWorkspaces = {
					workspaces: Array.isArray(legacySserializedBackupWorkspaces.rootURIWorkspaces) ? legacySserializedBackupWorkspaces.rootURIWorkspaces : [],
					folders: Array.isArray(legacySserializedBackupWorkspaces.folderWorkspaceInfos) ? legacySserializedBackupWorkspaces.folderWorkspaceInfos : [],
					emptyWindows: Array.isArray(legacySserializedBackupWorkspaces.emptyWorkspaceInfos) ? legacySserializedBackupWorkspaces.emptyWorkspaceInfos : [],
				};
			} catch (error) {
				if (error.code !== 'ENOENT') {
					this.logService.error(`Backup: Could not migrate legacy backup workspaces metadata: ${error.toString()}`);
				}
			}
		}

		return serializedBackupWorkspaces ?? Object.create(null);
	}

	protected getWorkspaceBackups(): IWorkspaceBackupInfo[] {
		if (this.isHotExitOnExitAndWindowClose()) {
			// Only non-folder windows are restored on main process launch when
			// hot exit is configured as onExitAndWindowClose.
			return [];
		}

		return this.workspaces.slice(0); // return a copy
	}

	protected getFolderBackups(): IFolderBackupInfo[] {
		if (this.isHotExitOnExitAndWindowClose()) {
			// Only non-folder windows are restored on main process launch when
			// hot exit is configured as onExitAndWindowClose.
			return [];
		}

		return this.folders.slice(0); // return a copy
	}

	isHotExitEnabled(): boolean {
		return this.getHotExitConfig() !== HotExitConfiguration.OFF;
	}

	private isHotExitOnExitAndWindowClose(): boolean {
		return this.getHotExitConfig() === HotExitConfiguration.ON_EXIT_AND_WINDOW_CLOSE;
	}

	private getHotExitConfig(): string {
		const config = this.configurationService.getValue<IFilesConfiguration>();

		return config?.files?.hotExit || HotExitConfiguration.ON_EXIT;
	}

	getEmptyWindowBackups(): IEmptyWindowBackupInfo[] {
		return this.emptyWindows.slice(0); // return a copy
	}

	registerWorkspaceBackup(workspaceInfo: IWorkspaceBackupInfo, migrateFrom?: string): string {
		if (!this.workspaces.some(workspace => workspaceInfo.workspace.id === workspace.workspace.id)) {
			this.workspaces.push(workspaceInfo);
			this.storeWorkspacesMetadata();
		}

		const backupPath = join(this.backupHome, workspaceInfo.workspace.id);

		if (migrateFrom) {
			this.moveBackupFolderSync(backupPath, migrateFrom);
		}

		return backupPath;
	}

	private moveBackupFolderSync(backupPath: string, moveFromPath: string): void {

		// Target exists: make sure to convert existing backups to empty window backups
		if (fs.existsSync(backupPath)) {
			this.convertToEmptyWindowBackupSync(backupPath);
		}

		// When we have data to migrate from, move it over to the target location
		if (fs.existsSync(moveFromPath)) {
			try {
				fs.renameSync(moveFromPath, backupPath);
			} catch (error) {
				this.logService.error(`Backup: Could not move backup folder to new location: ${error.toString()}`);
			}
		}
	}

	registerFolderBackup(folderInfo: IFolderBackupInfo): string {
		if (!this.folders.some(folder => this.backupUriComparer.isEqual(folderInfo.folderUri, folder.folderUri))) {
			this.folders.push(folderInfo);
			this.storeWorkspacesMetadata();
		}

		return join(this.backupHome, this.getFolderHash(folderInfo));
	}

	registerEmptyWindowBackup(emptyWindowInfo: IEmptyWindowBackupInfo): string {
		if (!this.emptyWindows.some(emptyWindow => !!emptyWindow.backupFolder && this.backupPathComparer.isEqual(emptyWindow.backupFolder, emptyWindowInfo.backupFolder))) {
			this.emptyWindows.push(emptyWindowInfo);
			this.storeWorkspacesMetadata();
		}

		return join(this.backupHome, emptyWindowInfo.backupFolder);
	}

	private async validateWorkspaces(rootWorkspaces: IWorkspaceBackupInfo[]): Promise<IWorkspaceBackupInfo[]> {
		if (!Array.isArray(rootWorkspaces)) {
			return [];
		}

		const seenIds: Set<string> = new Set();
		const result: IWorkspaceBackupInfo[] = [];

		// Validate Workspaces
		for (const workspaceInfo of rootWorkspaces) {
			const workspace = workspaceInfo.workspace;
			if (!isWorkspaceIdentifier(workspace)) {
				return []; // wrong format, skip all entries
			}

			if (!seenIds.has(workspace.id)) {
				seenIds.add(workspace.id);

				const backupPath = join(this.backupHome, workspace.id);
				const hasBackups = await this.doHasBackups(backupPath);

				// If the workspace has no backups, ignore it
				if (hasBackups) {
					if (workspace.configPath.scheme !== Schemas.file || await Promises.exists(workspace.configPath.fsPath)) {
						result.push(workspaceInfo);
					} else {
						// If the workspace has backups, but the target workspace is missing, convert backups to empty ones
						await this.convertToEmptyWindowBackup(backupPath);
					}
				} else {
					await this.deleteStaleBackup(backupPath);
				}
			}
		}

		return result;
	}

	private async validateFolders(folderWorkspaces: IFolderBackupInfo[]): Promise<IFolderBackupInfo[]> {
		if (!Array.isArray(folderWorkspaces)) {
			return [];
		}

		const result: IFolderBackupInfo[] = [];
		const seenIds: Set<string> = new Set();
		for (const folderInfo of folderWorkspaces) {
			const folderURI = folderInfo.folderUri;
			const key = this.backupUriComparer.getComparisonKey(folderURI);
			if (!seenIds.has(key)) {
				seenIds.add(key);

				const backupPath = join(this.backupHome, this.getFolderHash(folderInfo));
				const hasBackups = await this.doHasBackups(backupPath);

				// If the folder has no backups, ignore it
				if (hasBackups) {
					if (folderURI.scheme !== Schemas.file || await Promises.exists(folderURI.fsPath)) {
						result.push(folderInfo);
					} else {
						// If the folder has backups, but the target workspace is missing, convert backups to empty ones
						await this.convertToEmptyWindowBackup(backupPath);
					}
				} else {
					await this.deleteStaleBackup(backupPath);
				}
			}
		}

		return result;
	}

	private async validateEmptyWorkspaces(emptyWorkspaces: IEmptyWindowBackupInfo[]): Promise<IEmptyWindowBackupInfo[]> {
		if (!Array.isArray(emptyWorkspaces)) {
			return [];
		}

		const result: IEmptyWindowBackupInfo[] = [];
		const seenIds: Set<string> = new Set();

		// Validate Empty Windows
		for (const backupInfo of emptyWorkspaces) {
			const backupFolder = backupInfo.backupFolder;
			if (typeof backupFolder !== 'string') {
				return [];
			}

			if (!seenIds.has(backupFolder)) {
				seenIds.add(backupFolder);

				const backupPath = join(this.backupHome, backupFolder);
				if (await this.doHasBackups(backupPath)) {
					result.push(backupInfo);
				} else {
					await this.deleteStaleBackup(backupPath);
				}
			}
		}

		return result;
	}

	private async deleteStaleBackup(backupPath: string): Promise<void> {
		try {
			await Promises.rm(backupPath, RimRafMode.MOVE);
		} catch (error) {
			this.logService.error(`Backup: Could not delete stale backup: ${error.toString()}`);
		}
	}

	private prepareNewEmptyWindowBackup(): IEmptyWindowBackupInfo {

		// We are asked to prepare a new empty window backup folder.
		// Empty windows backup folders are derived from a workspace
		// identifier, so we generate a new empty workspace identifier
		// until we found a unique one.

		let emptyWorkspaceIdentifier = createEmptyWorkspaceIdentifier();
		while (this.emptyWindows.some(emptyWindow => !!emptyWindow.backupFolder && this.backupPathComparer.isEqual(emptyWindow.backupFolder, emptyWorkspaceIdentifier.id))) {
			emptyWorkspaceIdentifier = createEmptyWorkspaceIdentifier();
		}

		return { backupFolder: emptyWorkspaceIdentifier.id };
	}

	private async convertToEmptyWindowBackup(backupPath: string): Promise<boolean> {
		const newEmptyWindowBackupInfo = this.prepareNewEmptyWindowBackup();

		// Rename backupPath to new empty window backup path
		const newEmptyWindowBackupPath = join(this.backupHome, newEmptyWindowBackupInfo.backupFolder);
		try {
			await Promises.rename(backupPath, newEmptyWindowBackupPath);
		} catch (error) {
			this.logService.error(`Backup: Could not rename backup folder: ${error.toString()}`);
			return false;
		}
		this.emptyWindows.push(newEmptyWindowBackupInfo);

		return true;
	}

	private convertToEmptyWindowBackupSync(backupPath: string): boolean {
		const newEmptyWindowBackupInfo = this.prepareNewEmptyWindowBackup();

		// Rename backupPath to new empty window backup path
		const newEmptyWindowBackupPath = join(this.backupHome, newEmptyWindowBackupInfo.backupFolder);
		try {
			fs.renameSync(backupPath, newEmptyWindowBackupPath);
		} catch (error) {
			this.logService.error(`Backup: Could not rename backup folder: ${error.toString()}`);
			return false;
		}
		this.emptyWindows.push(newEmptyWindowBackupInfo);

		return true;
	}

	async getDirtyWorkspaces(): Promise<Array<IWorkspaceBackupInfo | IFolderBackupInfo>> {
		const dirtyWorkspaces: Array<IWorkspaceBackupInfo | IFolderBackupInfo> = [];

		// Workspaces with backups
		for (const workspace of this.workspaces) {
			if ((await this.hasBackups(workspace))) {
				dirtyWorkspaces.push(workspace);
			}
		}

		// Folders with backups
		for (const folder of this.folders) {
			if ((await this.hasBackups(folder))) {
				dirtyWorkspaces.push(folder);
			}
		}

		return dirtyWorkspaces;
	}

	private hasBackups(backupLocation: IWorkspaceBackupInfo | IEmptyWindowBackupInfo | IFolderBackupInfo): Promise<boolean> {
		let backupPath: string;

		// Empty
		if (isEmptyWindowBackupInfo(backupLocation)) {
			backupPath = backupLocation.backupFolder;
		}

		// Folder
		else if (isFolderBackupInfo(backupLocation)) {
			backupPath = join(this.backupHome, this.getFolderHash(backupLocation));
		}

		// Workspace
		else {
			backupPath = join(this.backupHome, backupLocation.workspace.id);
		}

		return this.doHasBackups(backupPath);
	}

	private async doHasBackups(backupPath: string): Promise<boolean> {
		try {
			const backupSchemas = await Promises.readdir(backupPath);

			for (const backupSchema of backupSchemas) {
				try {
					const backupSchemaChildren = await Promises.readdir(join(backupPath, backupSchema));
					if (backupSchemaChildren.length > 0) {
						return true;
					}
				} catch (error) {
					// invalid folder
				}
			}
		} catch (error) {
			// backup path does not exist
		}

		return false;
	}


	private storeWorkspacesMetadata(): void {
		const serializedBackupWorkspaces: ISerializedBackupWorkspaces = {
			workspaces: this.workspaces.map(({ workspace, remoteAuthority }) => {
				const serializedWorkspaceBackupInfo: ISerializedWorkspaceBackupInfo = {
					id: workspace.id,
					configURIPath: workspace.configPath.toString()
				};

				if (remoteAuthority) {
					serializedWorkspaceBackupInfo.remoteAuthority = remoteAuthority;
				}

				return serializedWorkspaceBackupInfo;
			}),
			folders: this.folders.map(({ folderUri, remoteAuthority }) => {
				const serializedFolderBackupInfo: ISerializedFolderBackupInfo =
				{
					folderUri: folderUri.toString()
				};

				if (remoteAuthority) {
					serializedFolderBackupInfo.remoteAuthority = remoteAuthority;
				}

				return serializedFolderBackupInfo;
			}),
			emptyWindows: this.emptyWindows.map(({ backupFolder, remoteAuthority }) => {
				const serializedEmptyWindowBackupInfo: ISerializedEmptyWindowBackupInfo = {
					backupFolder
				};

				if (remoteAuthority) {
					serializedEmptyWindowBackupInfo.remoteAuthority = remoteAuthority;
				}

				return serializedEmptyWindowBackupInfo;
			})
		};

		this.stateMainService.setItem(BackupMainService.backupWorkspacesMetadataStorageKey, serializedBackupWorkspaces);
	}

	protected getFolderHash(folder: IFolderBackupInfo): string {
		const folderUri = folder.folderUri;

		let key: string;
		if (folderUri.scheme === Schemas.file) {
			key = isLinux ? folderUri.fsPath : folderUri.fsPath.toLowerCase(); // for backward compatibility, use the fspath as key
		} else {
			key = folderUri.toString().toLowerCase();
		}

		return createHash('md5').update(key).digest('hex');
	}
}
