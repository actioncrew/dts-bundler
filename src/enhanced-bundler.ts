import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { DependencyGraph } from './dependency-graph';

interface BundlerOptions {
  entryPoint: string;
  outputFile: string;
  baseDir?: string;
  includeComments?: boolean;
  banner?: string;
  compilerOptions?: ts.CompilerOptions;
  packageName?: string;
}

interface TypeReference {
  moduleSpecifier: string;
  typeName: string;
  declaration?: ts.Declaration;
  isExternal: boolean;
}

const norm = (p: string) => p.replace(/\\/g, '/');

export class DTSBundler {
  private program!: ts.Program;
  private typeChecker!: ts.TypeChecker;
  private exportedSymbols = new Set<string>();
  private typeReferences = new Map<string, TypeReference>();
  private processedFiles = new Set<string>();
  private processingStack = new Set<string>();
  private resolvedTypes = new Map<string, ts.Declaration>();
  private externalImports = new Set<string>();
  
  constructor(private options: BundlerOptions, private graph: DependencyGraph) {
    this.options.baseDir = this.options.baseDir || path.dirname(this.options.entryPoint);
    this.initializeProgram();
  }

  private initializeProgram(): void {
    this.program = this.graph.getProgram();
    this.typeChecker = this.program.getTypeChecker();
  }

  async bundle(): Promise<void> {

    // First pass: collect all exported symbols and type references
    this.collectExportsAndReferences();

    // Second pass: resolve and inline all type references
    this.resolveTypeReferences();

    // Generate bundled content
    const bundledContent = this.generateBundle();

    // Ensure output directory exists
    const outputDir = path.dirname(this.options.outputFile);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write output
    await fs.promises.writeFile(this.options.outputFile, bundledContent, 'utf8');

    // Validate output
    await this.validateOutput();
  }

  private async validateOutput(): Promise<void> {
    const validationProgram = ts.createProgram([this.options.outputFile], {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      skipLibCheck: true
    });
    const diagnostics = ts.getPreEmitDiagnostics(validationProgram);
    if (diagnostics.length > 0) {
      console.error('Validation errors in bundled output:');
      diagnostics.forEach(d => console.error(ts.formatDiagnostic(d, {
        getCurrentDirectory: () => process.cwd(),
        getCanonicalFileName: f => f,
        getNewLine: () => '\n'
      })));
      throw new Error('Invalid bundled output');
    }
  }

  private collectExportsAndReferences(): void {
    const rootFiles = new Set(this.program.getRootFileNames());
    for (const sourceFile of this.program.getSourceFiles()) {
      if (rootFiles.has(sourceFile.fileName) && this.shouldProcessFile(sourceFile.fileName)) {
        this.processedFiles.add(sourceFile.fileName);
        this.processFileForExportsAndReferences(sourceFile);
      }
    }
  }

  private processFileForExportsAndReferences(sourceFile: ts.SourceFile): void {
    if (this.processingStack.has(sourceFile.fileName)) {
      console.warn(`Circular dependency detected in ${sourceFile.fileName}`);
      return;
    }
    this.processingStack.add(sourceFile.fileName);

    ts.forEachChild(sourceFile, (node) => {
      // Collect exports
      if (ts.isExportDeclaration(node)) {
        this.processExportDeclaration(node);
      } else if (this.hasExportModifier(node)) {
        this.processExportedDeclaration(node);
      }

      // Collect type references
      this.collectTypeReferences(node, sourceFile);
    });

    this.processingStack.delete(sourceFile.fileName);
  }

  private collectTypeReferences(node: ts.Node, sourceFile: ts.SourceFile): void {
    // Handle import type nodes: import("module").Type
    if (ts.isImportTypeNode(node)) {
      if (node.qualifier && ts.isIdentifier(node.qualifier)) {
        const typeName = node.qualifier.text;
        const moduleSpecifier = node.argument && ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal) ?
          node.argument.literal.text : '';

        if (moduleSpecifier) {
          const isExternal = !this.isSamePackage(moduleSpecifier);
          this.typeReferences.set(typeName, {
            moduleSpecifier,
            typeName,
            declaration: undefined,
            isExternal
          });

          if (isExternal) {
            this.externalImports.add(moduleSpecifier);
          }
        }
      }
    }

    // Handle qualified names: Namespace.Type
    if (ts.isTypeReferenceNode(node) && ts.isQualifiedName(node.typeName)) {
      const leftmost = this.getLeftmostIdentifier(node.typeName);
      if (leftmost && ts.isIdentifier(leftmost)) {
        const cacheKey = `${sourceFile.fileName}:${leftmost.text}`;
        if (this.resolvedTypes.has(cacheKey)) return;

        const symbol = this.typeChecker.getSymbolAtLocation(leftmost);
        if (symbol && symbol.declarations && symbol.declarations.length > 0) {
          const declaration = symbol.declarations[0];
          this.resolvedTypes.set(cacheKey, declaration);
          const declarationFile = declaration.getSourceFile().fileName;

          if (declarationFile !== sourceFile.fileName && this.shouldProcessFile(declarationFile)) {
            const moduleSpecifier = this.getRelativePath(sourceFile.fileName, declarationFile);
            const isExternal = !this.isSamePackage(moduleSpecifier);

            this.typeReferences.set(leftmost.text, {
              moduleSpecifier,
              typeName: this.getTypeNameFromQualifiedName(node.typeName),
              declaration,
              isExternal
            });

            if (isExternal) {
              this.externalImports.add(moduleSpecifier);
            }
          }
        }
      }
    }

    ts.forEachChild(node, (child) => this.collectTypeReferences(child, sourceFile));
  }

  private isSamePackage(moduleSpecifier: string): boolean {
    // Check if module specifier points to the same package
    return moduleSpecifier.startsWith('./') ||
      moduleSpecifier.startsWith('../') ||
      moduleSpecifier === '.' ||
      moduleSpecifier === '..';
  }

  private getLeftmostIdentifier(node: ts.QualifiedName): ts.Identifier | null {
    if (ts.isIdentifier(node.left)) {
      return node.left;
    } else if (ts.isQualifiedName(node.left)) {
      return this.getLeftmostIdentifier(node.left);
    }
    return null;
  }

  private getTypeNameFromQualifiedName(node: ts.QualifiedName): string {
    if (ts.isIdentifier(node.right)) {
      return node.right.text;
    }
    return '';
  }

  private getRelativePath(from: string, to: string): string {
    const relative = path.relative(path.dirname(from), to);
    return relative.startsWith('.') ? relative : './' + relative;
  }

  private resolveTypeReferences(): void {
    for (const [, ref] of this.typeReferences) {
      // Only inline types from the same package
      if (ref.declaration && !ref.isExternal) {
        if (ts.isInterfaceDeclaration(ref.declaration) ||
          ts.isTypeAliasDeclaration(ref.declaration) ||
          ts.isClassDeclaration(ref.declaration) ||
          ts.isEnumDeclaration(ref.declaration)) {
          this.exportedSymbols.add(ref.typeName);
        }
      }
    }
  }

  private processExportDeclaration(node: ts.ExportDeclaration): void {
    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        this.exportedSymbols.add(element.name.text);
      }
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const moduleSpecifier = node.moduleSpecifier.text;
        const isExternal = !this.isSamePackage(moduleSpecifier);

        if (isExternal) {
          this.externalImports.add(moduleSpecifier);
        } else {
          const sourceFile = this.program.getSourceFiles().find(f => f.fileName === modulePath);
          const modulePath = this.resolveModulePath(moduleSpecifier, sourceFile!.fileName);
          if (sourceFile && this.shouldProcessFile(sourceFile.fileName)) {
            this.processFileForExportsAndReferences(sourceFile);
          }
        }
      }
    }
  }

  private resolveModulePath(moduleSpecifier: string, fromFile: string): string {
    try {
      const resolved = require.resolve(path.resolve(path.dirname(fromFile), moduleSpecifier));
      return resolved.endsWith('.d.ts') ? resolved : resolved + '.d.ts';
    } catch {
      return path.resolve(path.dirname(fromFile), moduleSpecifier);
    }
  }

  private processExportedDeclaration(node: ts.Node): void {
    const names = this.getDeclarationNames(node);
    for (const name of names) {
      this.exportedSymbols.add(name);
    }
  }

  private hasExportModifier(node: ts.Node): boolean {
    return ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) || false;
  }

  private getDeclarationNames(node: ts.Node): string[] {
    const names: string[] = [];

    if (ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isEnumDeclaration(node)) {
      if (node.name) {
        names.push(node.name.text);
      }
    } else if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.push(declaration.name.text);
        }
      }
    } else if (ts.isModuleDeclaration(node)) {
      if (node.name && ts.isIdentifier(node.name)) {
        names.push(node.name.text);
      }
    }

    return names;
  }

  private shouldProcessFile(fileName: string): boolean {
    if (!fileName.endsWith('.d.ts') ||
        fileName.includes('node_modules') ||
        fileName.includes('typescript/lib')) {
      return false;
    }

    // Only include files under the current entry's baseDir
    const baseDir = this.options.baseDir ?? path.dirname(this.options.entryPoint);
    return fileName.startsWith(norm(path.resolve(baseDir)));
  }

  private generateBundle(): string {
    const result: string[] = [];
    const printer = ts.createPrinter({
      removeComments: !this.options.includeComments,
      newLine: ts.NewLineKind.LineFeed,
      omitTrailingSemicolon: false,
      noEmitHelpers: true
    });

    if (this.options.banner) {
      result.push(this.options.banner);
      result.push('');
    }

    // Add external imports at the top
    if (this.externalImports.size > 0) {
      Array.from(this.externalImports).sort().forEach(importPath => {
        result.push(`import type * as ${this.getImportAlias(importPath)} from '${importPath}';`);
      });
      result.push('');
    }

    const interImports = new Map<string, Set<string>>();
    const declaredSymbols = this.graph.getExportsForEntry(this.options.entryPoint);

    for (const [specifier, symbols] of this.graph.getImportedTypes(this.options.entryPoint) || []) {
      const resolvedEntry = this.graph.resolveSpecifierToEntry(specifier, this.options.entryPoint);

      if (resolvedEntry === this.options.entryPoint) {
        // Skip symbols declared in the same entry
        continue;
      }

      // Include symbols from other entries or external packages
      for (const sym of symbols) {
        if (!declaredSymbols.has(sym)) {
          if (!interImports.has(specifier)) interImports.set(specifier, new Set());
          interImports.get(specifier)!.add(sym);
        }
      }
    }

    // Emit inter-package imports
    if (interImports.size > 0) {
      Array.from(interImports.keys()).sort().forEach(specifier => {
        const syms = Array.from(interImports.get(specifier)!).sort();
        if (syms.length) {
          result.push(`import { ${syms.join(', ')} } from '${specifier}';`);
        } else {
          const alias = this.getImportAlias(specifier);
          result.push(`import * as ${alias} from '${specifier}';`);
        }
      });
      result.push('');
    }

    const transformer = <T extends ts.Node>(context: ts.TransformationContext) => (rootNode: T) => {
      const visit = (node: ts.Node): ts.Node => {
        // Handle import type nodes: import("module").Type → ExternalModule.Type
        if (ts.isImportTypeNode(node)) {
          if (node.qualifier && ts.isIdentifier(node.qualifier)) {
            const typeName = node.qualifier.text;
            const ref = this.typeReferences.get(typeName);

            if (ref && ref.isExternal) {
              const alias = this.getImportAlias(ref.moduleSpecifier);
              return ts.factory.createTypeReferenceNode(
                ts.factory.createQualifiedName(
                  ts.factory.createIdentifier(alias),
                  ts.factory.createIdentifier(typeName)
                ),
                node.typeArguments
              );
            } else {
              return ts.factory.createTypeReferenceNode(
                node.qualifier,
                node.typeArguments
              );
            }
          }
        }

        // Handle qualified names: Only inline same-package types
        if (ts.isTypeReferenceNode(node) && ts.isQualifiedName(node.typeName)) {
          const leftmost = this.getLeftmostIdentifier(node.typeName);
          if (leftmost && this.typeReferences.has(leftmost.text)) {
            const ref = this.typeReferences.get(leftmost.text)!;
            if (!ref.isExternal) {
              return ts.factory.createTypeReferenceNode(
                ts.factory.createIdentifier(node.typeName.right.getText()),
                node.typeArguments
              );
            }
          }
        }

        return ts.visitEachChild(node, visit, context);
      };
      return ts.visitNode(rootNode, visit);
    };

    // Process all relevant source files
    for (const sourceFile of this.program.getSourceFiles()) {
      if (this.shouldProcessFile(sourceFile.fileName)) {
        let hasDeclarations = false;
        const transformed = ts.transform(sourceFile, [transformer]).transformed[0] as ts.SourceFile;

        for (const statement of transformed.statements) {
          // Skip import declarations (we handle them separately)
          if (ts.isImportDeclaration(statement)) {
            continue;
          }

          let statementText = printer.printNode(ts.EmitHint.Unspecified, statement, transformed);

          // Handle export declarations
          if (ts.isExportDeclaration(statement)) {
            if (!statement.exportClause) {
              // export * from 'module' - preserve if external
              const moduleSpecifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ?
                statement.moduleSpecifier.text : '';
              if (moduleSpecifier && this.isSamePackage(moduleSpecifier)) {
                continue; // Skip same-package exports
              }
            } else if (statement.moduleSpecifier) {
              // export { ... } from 'module' - preserve if external
              const moduleSpecifier = ts.isStringLiteral(statement.moduleSpecifier) ?
                statement.moduleSpecifier.text : '';
              if (moduleSpecifier && this.isSamePackage(moduleSpecifier)) {
                // Remove the from clause for same-package exports
                statementText = statementText.replace(/\s+from\s+['"][^'"]+['"]/, '');
              }
            }
          }

          if (!hasDeclarations) {
            hasDeclarations = true;
          }
          result.push(statementText);
          result.push('');
        }

        if (hasDeclarations) {
          result.push('');
        }
      }
    }

    return result.join('\n');
  }

  private getImportAlias(moduleSpecifier: string): string {
    // Create a safe alias for the import
    return moduleSpecifier
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/^_+/, '')
      .replace(/_+/g, '_') || 'external';
  }
}
