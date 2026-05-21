import { readFile, writeFile } from "node:fs/promises";

export interface PersistenceAdapter {
  load(): string | null | Promise<string | null>;
  save(data: string): void | Promise<void>;
}

export function filePersistence(path: string): PersistenceAdapter {
  return {
    async load() {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async save(data: string) {
      await writeFile(path, data);
    },
  };
}

export const runtime = "native-go";
