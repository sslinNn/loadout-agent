export type CanonicalMcp = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

export interface HarnessAdapter {
  id: string;
  isPresent(homeDir: string): boolean;
  extraSkillRoots?(opts: { homeDir: string; projectPath: string | null }): string[];
  watchPaths(opts: { homeDir: string; projectPaths: string[] }): string[];
  readMcp(homeDir: string): Record<string, CanonicalMcp>;
  writeMcpEntry(homeDir: string, name: string, entry: CanonicalMcp): void;
  removeMcpEntry(homeDir: string, name: string): void;
  readProjectMcp?(projectPath: string): Record<string, CanonicalMcp>;
  writeProjectMcpEntry?(projectPath: string, name: string, entry: CanonicalMcp): void;
  removeProjectMcpEntry?(projectPath: string, name: string): void;
}
