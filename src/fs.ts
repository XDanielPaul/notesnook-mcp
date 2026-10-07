// Attachments are not supported. This file storage never touches the network,
// so it can never upload or delete remote attachment blobs.
import type { IFileStorage } from "@notesnook/core";

const noop = () => ({ execute: async () => false, cancel: async () => {} });

export const NoAttachmentsFS: IFileStorage = {
  downloadFile: noop,
  uploadFile: noop,
  async readEncrypted() {
    return undefined;
  },
  async writeEncryptedBase64() {
    throw new Error("Attachments are not supported by notesnook-mcp.");
  },
  async deleteFile() {
    return true;
  },
  async bulkDeleteFiles() {
    return true;
  },
  async exists() {
    return false;
  },
  async bulkExists() {
    return [];
  },
  async getUploadedFileSize() {
    return 0;
  },
  async clearFileStorage() {},
  async hashBase64() {
    throw new Error("Attachments are not supported by notesnook-mcp.");
  }
};
