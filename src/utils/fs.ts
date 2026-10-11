// Small file helpers built on vscode.workspace.fs so they work in any VS Code fork.
import * as vscode from 'vscode';
import { BINARY_SNIFF_BYTES } from '../constants';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export const exists = async (uri: vscode.Uri): Promise<boolean> => {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
};

export const readBytes = (uri: vscode.Uri): Thenable<Uint8Array> => vscode.workspace.fs.readFile(uri);

export const readText = async (uri: vscode.Uri): Promise<string> => decoder.decode(await readBytes(uri));

export const readTextOrNull = async (uri: vscode.Uri): Promise<string | null> => {
  try {
    return await readText(uri);
  } catch {
    return null;
  }
};

/** Reads and parses a JSON file; returns null if missing or invalid. */
export const readJson = async <T>(uri: vscode.Uri): Promise<T | null> => {
  const text = await readTextOrNull(uri);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

/** Writes bytes, creating parent folders as needed. */
export const writeBytes = async (uri: vscode.Uri, data: Uint8Array): Promise<void> => {
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
  await vscode.workspace.fs.writeFile(uri, data);
};

export const writeText = (uri: vscode.Uri, text: string): Promise<void> => writeBytes(uri, encoder.encode(text));

export const writeJson = (uri: vscode.Uri, value: unknown): Promise<void> =>
  writeText(uri, `${JSON.stringify(value, null, 2)}\n`);

/** Deletes a file if it exists; never throws for a missing file. */
export const deleteIfExists = async (uri: vscode.Uri): Promise<void> => {
  try {
    await vscode.workspace.fs.delete(uri, { useTrash: false });
  } catch (err) {
    if (!(err instanceof vscode.FileSystemError && err.code === 'FileNotFound')) {
      throw err;
    }
  }
};

/** Heuristic binary check: any NUL byte in the first few KB. */
export const isBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);

export const decodeText = (bytes: Uint8Array): string => decoder.decode(bytes);

/** Last path segment of a POSIX relative path. */
export const baseName = (relPath: string): string => relPath.slice(relPath.lastIndexOf('/') + 1);

/** Folder part of a POSIX relative path ('' for top-level files). */
export const dirName = (relPath: string): string => relPath.slice(0, Math.max(relPath.lastIndexOf('/'), 0));
