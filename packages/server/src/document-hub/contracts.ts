import type { RowAddress } from "@epicenter/row-sync";
import type { CurrentStateRecordsPartition } from "../records/current-state-contracts.js";

/** Runtime-specific WebSocket acceptance behind the shared document route. */
export type WorkspaceDocuments = {
  handleUpgrade(input: {
    partition: CurrentStateRecordsPartition;
    address: RowAddress;
    authorizationExpiresAt: number;
    request: Request;
  }): Response | Promise<Response>;
  rejectUpgrade(input: {
    request: Request;
    code: number;
    reason: string;
  }): Response | Promise<Response>;
};
