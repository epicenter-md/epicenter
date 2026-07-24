export type EvidenceFeatures = {
	secureContext: boolean;
	dedicatedWorker: boolean;
	opfs: boolean;
	webLocks: boolean;
	syncAccessHandle: boolean;
	storageUsageBytes?: number;
	storageQuotaBytes?: number;
};

export type EvidenceSnapshot = {
	rowCount: number;
	semanticSha256: string;
	rows: { id: string; title: string; writer: string }[];
	storageUsageBytes?: number;
	storageQuotaBytes?: number;
};

export type HungSyncStatus = {
	started: boolean;
	hungOutcome?: string;
};

export type BrowserEvidenceDriver = {
	features(): Promise<EvidenceFeatures>;
	open(workerName: string): Promise<void>;
	dispose(): Promise<void>;
	create(title: string, writer: string): Promise<{ id: string }>;
	get(
		rowId: string,
	): Promise<{ id: string; title: string; writer: string } | undefined>;
	snapshot(): Promise<EvidenceSnapshot>;
	setDocument(rowId: string, content: string): Promise<string>;
	readDocument(rowId: string): Promise<string>;
	startHungSync(): void;
	hungSyncStatus(): HungSyncStatus;
	terminateWorker(): Promise<void>;
};
