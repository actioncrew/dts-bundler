// dependency-graph-monorepo.ts
import * as ts from 'typescript';
import * as path from 'path';
import { DtsEntryPoint } from './config-manager';

const norm = (p: string) => p.replace(/\\/g, '/');

export class DependencyGraph {
  private program: ts.Program;
  private nodes: string[];
  private edges = new Map<string, Set<string>>();
  private cycles: string[][] = [];
  private specifierToDts = new Map<string, string>();
  private exportedTypes = new Map<string, Set<string>>();
  private importedTypes = new Map<string, Map<string, Set<string>>>();
  private entryRoots = new Map<string, string>();
  private sourceFileCache = new Map<string, ts.SourceFile>();

  constructor(files: Map<string, string>, entryPoints: DtsEntryPoint[], compilerOptions: ts.CompilerOptions) {
    
    this.nodes = entryPoints.map(ep => norm(ep.dtsFile));
    
    const allFileNames = [...files.keys()];

    // Create program with custom options
    this.program = ts.createProgram({
      rootNames: allFileNames, 
      options: compilerOptions,
      host: this.createInMemoryCompilerHost(files, compilerOptions)
    });

    // Pre-cache all source files for faster access
    this.program.getSourceFiles().forEach(sf => {
      this.sourceFileCache.set(norm(sf.fileName), sf);
    });

    // Build entryRoots for each sub-package entry using program files
    for (const ep of entryPoints) {
      const file = norm(ep.dtsFile);
      const sourceFile = this.getSourceFile(file);
      if (sourceFile) {
        this.entryRoots.set(file, norm(path.dirname(file)));
      } else {
        this.entryRoots.set(file, file); // Fallback to file itself if not found
      }
    }

    // Build alias map for all entries
    this.buildSpecifierMap(entryPoints);

    // Collect types
    for (const entry of this.nodes) {
      this.collectTypesForEntry(entry);
    }

    // Build edges & detect cycles
    this.buildEdges();
    this.detectCycles();
  }

  public getProgram() {
    return this.program;
  }

  private createInMemoryCompilerHost(
    files: Map<string, string>,          // preloaded or generated .d.ts
    options: ts.CompilerOptions
  ): ts.CompilerHost {
    const defaultHost = ts.createCompilerHost(options);
  
    return {
      ...defaultHost,
  
      fileExists: fileName =>
        files.has(norm(path.resolve(fileName))) || defaultHost.fileExists(fileName),
  
      readFile: fileName => {
        const normalized = norm(path.resolve(fileName));
        return files.get(normalized) ?? defaultHost.readFile(fileName);
      },
  
      writeFile: (fileName, data) => {
        const normalized = norm(path.resolve(fileName));
        files.set(normalized, data); // ✅ capture emitted d.ts into memory
      },
  
      getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
        const normalized = norm(path.resolve(fileName));
        const text = files.get(normalized);
        if (text !== undefined) {
          return ts.createSourceFile(fileName, text, languageVersion, true);
        }
        return defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
      },
      resolveModuleNames: (moduleNames, containingFile) => {
        return moduleNames.map(spec => {
          // Relative import
          if (spec.startsWith('.')) {
            let base = path.resolve(path.dirname(containingFile), spec);
            base = base.replace(/\.(ts|mts|cts|js|mjs|cjs|d\.ts|d\.mts)$/, '');
            const candidates = [
              norm(base + '.d.ts'),
              norm(base + '.d.mts'),
              norm(base + '.mjs'), // Add mjs support
              norm(path.join(base, 'index.d.ts')),
              norm(path.join(base, 'index.mjs')), // Add mjs index support
            ];

            for (const c of candidates) {
              if (files.has(c)) {
                return { resolvedFileName: c, extension: ts.Extension.Dts };
              }
            }
          }

          // Alias import
          if (this.specifierToDts.has(spec)) {
            const file = this.specifierToDts.get(spec)!;
            return { resolvedFileName: file, extension: ts.Extension.Dts };
          }

          // Fallback: let TS do its normal node resolution
          const resolved = ts.resolveModuleName(spec, containingFile, options, defaultHost);
          return resolved.resolvedModule ?? undefined;
        });
      }
    };
  }

  private buildSpecifierMap(entryPoints: DtsEntryPoint[]) {
    this.specifierToDts.clear();
    for (const ep of entryPoints) {
      if (!ep.alias) continue;
      const file = norm(ep.dtsFile);

      // Only add aliases for files that exist in the program
      if (this.sourceFileCache.has(file)) {
        // Exact alias
        this.specifierToDts.set(ep.alias, file);

        // Cleaned alias (remove trailing /*)
        const cleaned = ep.alias.replace(/\*+$/, '').replace(/\/+$/, '');
        if (cleaned && cleaned !== ep.alias) {
          this.specifierToDts.set(cleaned, file);
        }

        // Map barrel directory if index.d.ts
        if (path.basename(file) === 'index.d.ts') {
          this.specifierToDts.set(cleaned, file);
        }
      }
    }
  }

  private getSourceFile(filePath: string): ts.SourceFile | undefined {
    const normalized = norm(filePath);
    return this.sourceFileCache.get(normalized);
  }

  public findAllDtsFilesFromEntry(entry: string): string[] {
    const seen = new Set<string>();
    const root = this.entryRoots.get(entry)!;
    const queue = [entry];

    while (queue.length) {
      const file = queue.pop()!;
      const normalizedFile = norm(file);
      
      if (seen.has(normalizedFile)) continue;
      
      const sf = this.getSourceFile(normalizedFile);
      if (!sf || !(normalizedFile.endsWith('.d.ts') || normalizedFile.endsWith('.d.mts'))) continue;
      
      if (!normalizedFile.startsWith(root)) continue;

      seen.add(normalizedFile);

      // Find all imports and exports in this file
      this.findImportsAndExports(sf, (spec) => {
        if (spec) {
          const resolved = this.resolveSpecifierToFile(normalizedFile, spec);
          if (resolved && !seen.has(resolved)) {
            queue.push(resolved);
          }
        }
      });
    }

    return Array.from(seen);
  }

  private findImportsAndExports(sourceFile: ts.SourceFile, callback: (specifier: string) => void): void {
    ts.forEachChild(sourceFile, node => {
      let spec: string | undefined;

      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        spec = node.moduleSpecifier.text;
      }

      if (ts.isImportTypeNode(node) &&
          node.argument && ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal)) {
        spec = node.argument.literal.text;
      }

      if (spec) {
        callback(spec);
      }
    });
  }

  private resolveSpecifierToFile(fromFile: string, spec: string): string | null {
    // Relative paths
    if (spec.startsWith('.')) {
      let base = norm(path.resolve(path.dirname(fromFile), spec));
      
      // Try exact match first
      if (this.sourceFileCache.has(base)) {
        return base;
      }

      // Try with different extensions
      const extensions = ['.d.ts', '.d.mts', '.mjs', '.js', '.ts'];
      for (const ext of extensions) {
        const candidate = base + ext;
        if (this.sourceFileCache.has(candidate)) {
          return candidate;
        }
      }

      // Try barrel files
      const barrelCandidates = [
        norm(path.join(base, 'index.d.ts')),
        norm(path.join(base, 'index.d.mts')),
        norm(path.join(base, 'index.mjs'))
      ];
      
      for (const candidate of barrelCandidates) {
        if (this.sourceFileCache.has(candidate)) {
          return candidate;
        }
      }

      return null;
    }

    // Aliases
    if (this.specifierToDts.has(spec)) {
      const target = this.specifierToDts.get(spec)!;
      if (this.sourceFileCache.has(target)) {
        return target;
      }
    }

    // Nested alias
    for (const [alias, target] of this.specifierToDts.entries()) {
      if (spec.startsWith(alias + '/')) {
        const remaining = spec.slice(alias.length + 1);
        const baseDir = path.dirname(target);
        
        // Try direct file
        const candidate = path.join(baseDir, remaining + '.d.ts');
        if (this.sourceFileCache.has(candidate)) {
          return candidate;
        }

        // Try barrel file
        const barrelCandidate = path.join(baseDir, remaining, 'index.d.ts');
        if (this.sourceFileCache.has(barrelCandidate)) {
          return barrelCandidate;
        }

        // Try directory barrel
        const dirBarrel = path.join(baseDir, remaining, 'index.d.ts');
        if (this.sourceFileCache.has(dirBarrel)) {
          return dirBarrel;
        }
      }
    }

    return null;
  }

  public resolveSpecifierToEntry(spec: string, fromFile: string): string | null {
    const entryRoot = this.entryRoots.get(fromFile);
    if (!entryRoot) return null;

    if (spec.startsWith('.')) {
      const resolvedFile = this.resolveSpecifierToFile(fromFile, spec);
      if (!resolvedFile) return null;

      // Only return the entry if it belongs to the **same package root**
      for (const entry of this.nodes) {
        const entryRootForFile = this.entryRoots.get(entry);
        if (entryRootForFile && resolvedFile.startsWith(entryRootForFile) && entryRootForFile === entryRoot) {
          return entry;
        }
      }

      return null;
    }

    // Handle aliases
    if (this.specifierToDts.has(spec)) {
      const target = this.specifierToDts.get(spec)!;
      if (this.sourceFileCache.has(target)) {
        return target;
      }
    }

    // Handle nested aliases
    for (const [alias, target] of this.specifierToDts.entries()) {
      if (spec.startsWith(alias + '/')) {
        return target;
      }
    }

    return null;
  }

  private collectTypesForEntry(entry: string) {
    const allFiles = this.findAllDtsFilesFromEntry(entry);
    const exported = new Set<string>();
    const imported = new Map<string, Set<string>>();

    for (const file of allFiles) {
      const sf = this.getSourceFile(file);
      if (!sf) continue;

      this.extractTypesFromSourceFile(sf, imported, exported);
    }

    this.exportedTypes.set(entry, exported);
    this.importedTypes.set(entry, imported);
  }

  private extractTypesFromSourceFile(
    sf: ts.SourceFile,
    imported: Map<string, Set<string>>,
    exported: Set<string>
  ): void {
    const visit = (node: ts.Node) => {
      // Import declarations
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (!imported.has(spec)) imported.set(spec, new Set());
        const importedSymbols = imported.get(spec)!;

        const clause = node.importClause;
        if (clause?.namedBindings) {
          if (ts.isNamedImports(clause.namedBindings)) {
            clause.namedBindings.elements.forEach(el => {
              if (el.name) importedSymbols.add(el.name.text);
            });
          } else if (ts.isNamespaceImport(clause.namedBindings)) {
            if (clause.namedBindings.name) importedSymbols.add(clause.namedBindings.name.text);
          }
        }
      }

      // Export declarations
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (!imported.has(spec)) imported.set(spec, new Set());
        const importedSymbols = imported.get(spec)!;

        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          node.exportClause.elements.forEach(el => {
            if (el.name) importedSymbols.add(el.name.text);
          });
        }
      }

      // Import type nodes
      if (ts.isImportTypeNode(node)) {
        const arg = node.argument;
        if (arg && ts.isLiteralTypeNode(arg)) {
          const lit = arg.literal;
          if (lit && ts.isStringLiteral(lit)) {
            const spec = lit.text;
            if (!imported.has(spec)) imported.set(spec, new Set());
            if (node.qualifier && ts.isIdentifier(node.qualifier)) {
              imported.get(spec)!.add(node.qualifier.text);
            }
          }
        }
      }

      // Exported declarations
      if (this.isExportedDeclaration(node)) {
        const name = this.getDeclarationName(node);
        if (name) {
          exported.add(name);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);
  }

  private isExportedDeclaration(node: ts.Node): boolean {
    if (!(ts.isVariableStatement(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node))) {
      return false;
    }

    const modifiers = (node as any).modifiers as ts.Modifier[] | undefined;
    return modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword) || false;
  }

  private getDeclarationName(node: ts.Node): string | null {
    if (ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isFunctionDeclaration(node)) {
      return node.name?.text || null;
    }

    if (ts.isVariableStatement(node)) {
      return node.declarationList.declarations[0]?.name.getText() || null;
    }

    return null;
  }

  public getExternalImportsForEntry(entryFile: string): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    const imports = this.importedTypes.get(entryFile);
    if (!imports) return result;

    for (const [specifier, symbols] of imports.entries()) {
      const resolvedEntry = this.resolveSpecifierToEntry(specifier, entryFile);
      if (resolvedEntry) continue;

      if (!result.has(specifier)) result.set(specifier, new Set<string>());
      for (const s of symbols) result.get(specifier)!.add(s);
    }

    return result;
  }

  public getAllExternalImports(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const entry of this.nodes) {
      const ext = this.getExternalImportsForEntry(entry);
      for (const [specifier, symbols] of ext.entries()) {
        if (!out.has(specifier)) out.set(specifier, new Set<string>());
        for (const s of symbols) out.get(specifier)!.add(s);
      }
    }
    return out;
  }

  public getImportedTypes(entry: string): Map<string, Set<string>> | undefined {
    return this.importedTypes.get(entry);
  }

  public getExportsForEntry(entryFile: string): Set<string> {
    return this.exportedTypes.get(entryFile) ?? new Set();
  }

  private buildEdges() {
    this.edges.clear();

    for (const entry of this.nodes) {
      const deps = new Set<string>();
      const imports = this.importedTypes.get(entry);
      if (!imports) continue;

      for (const spec of imports.keys()) {
        const resolved = this.resolveSpecifierToEntry(spec, entry);
        if (!resolved || resolved === entry) continue;
        deps.add(resolved);
      }

      this.edges.set(entry, deps);
    }
  }

  private detectCycles() {
    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (node: string, pathStack: string[]) => {
      if (stack.has(node)) {
        const idx = pathStack.indexOf(node);
        this.cycles.push(pathStack.slice(idx).concat(node));
        return;
      }
      if (visited.has(node)) return;
      visited.add(node);
      stack.add(node);
      pathStack.push(node);

      for (const dep of this.edges.get(node) || []) dfs(dep, pathStack);

      stack.delete(node);
      pathStack.pop();
    };

    for (const node of this.nodes) dfs(node, []);
  }

  topoSort(): string[] {
    const inDegree = new Map<string, number>();
    const outEdges = new Map<string, Set<string>>();
    for (const n of this.nodes) { inDegree.set(n, 0); outEdges.set(n, new Set()); }

    for (const [node, deps] of this.edges.entries()) {
      for (const dep of deps) {
        outEdges.get(dep)!.add(node);
        inDegree.set(node, (inDegree.get(node) || 0) + 1);
      }
    }

    const queue = [...this.nodes.filter(n => inDegree.get(n)! === 0)];
    const order: string[] = [];

    while (queue.length) {
      const n = queue.shift()!;
      order.push(n);
      for (const o of outEdges.get(n)!) {
        inDegree.set(o, inDegree.get(o)! - 1);
        if (inDegree.get(o)! === 0) queue.push(o);
      }
    }

    const remaining = this.nodes.filter(n => !order.includes(n));
    if (remaining.length) order.push(...remaining);
    return order;
  }

  getCycles(): string[][] { return this.cycles; }
  getEdges(): Map<string, Set<string>> { return this.edges; }

  public getSpecifierForFile(file: string): string | undefined {
    for (const [specifier, resolvedFile] of this.specifierToDts.entries()) {
      if (resolvedFile === file) {
        return specifier;
      }
    }
    return undefined;
  }

  public getEntryPointForFile(file: string): string | undefined {
    for (const entry of this.nodes) {
      const root = this.entryRoots.get(entry);
      if (root && file.startsWith(root)) {
        return entry;
      }
    }
    return undefined;
  }

  public getSourceFiles(): ts.SourceFile[] {
    return Array.from(this.sourceFileCache.values());
  }
}