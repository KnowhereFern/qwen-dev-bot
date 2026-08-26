import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { harnessStateRoot } from './core/state-paths.js';

export interface ProjectRegistration {
  id: string;
  root: string;
  configPath: string;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
}

interface RegistryData {
  version: 1;
  projects: ProjectRegistration[];
}

export class ProjectRegistry {
  readonly file: string;

  constructor(stateRoot = harnessStateRoot()) {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    this.file = path.join(stateRoot, 'registry.json');
  }

  list(): ProjectRegistration[] {
    return [...this.read().projects];
  }

  register(input: Omit<ProjectRegistration, 'installedAt' | 'updatedAt'>): ProjectRegistration {
    const data = this.read();
    const now = Date.now();
    const existing = data.projects.find((project) => project.id === input.id || project.root === input.root);
    const registration: ProjectRegistration = existing
      ? { ...existing, ...input, updatedAt: now }
      : { ...input, installedAt: now, updatedAt: now };
    data.projects = data.projects.filter((project) => project.id !== registration.id && project.root !== registration.root);
    data.projects.push(registration);
    this.write(data);
    return registration;
  }

  unregister(idOrRoot: string): boolean {
    const data = this.read();
    const before = data.projects.length;
    const resolved = path.resolve(idOrRoot);
    data.projects = data.projects.filter((project) => project.id !== idOrRoot && path.resolve(project.root) !== resolved);
    if (data.projects.length !== before) this.write(data);
    return data.projects.length !== before;
  }

  private read(): RegistryData {
    if (!existsSync(this.file)) return { version: 1, projects: [] };
    const value = JSON.parse(readFileSync(this.file, 'utf8')) as RegistryData;
    if (value.version !== 1 || !Array.isArray(value.projects)) throw new Error(`Unsupported registry: ${this.file}`);
    return value;
  }

  private write(data: RegistryData): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
    chmodSync(this.file, 0o600);
  }
}
