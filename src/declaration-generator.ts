// dts-generator.ts
import * as ts from 'typescript';
import * as path from 'path';

const norm = (p: string) => p.replace(/\\/g, '/');

export class DTSGenerator {
  private program: ts.Program;
  private inMemoryFiles = new Map<string, string>();

  constructor(
    private entryPoints: string[], // absolute paths to entry .ts files
    compilerOptions: ts.CompilerOptions = {}
  ) {
    const options: ts.CompilerOptions = {
      ...compilerOptions,
      declaration: true,
      emitDeclarationOnly: true,
      noEmit: false,
      skipLibCheck: true,
      strict: true,
      allowJs: true,
    };

    this.program = ts.createProgram(this.entryPoints, options);
  }

  public generate(): Map<string, string> {
    const diagnostics = ts.getPreEmitDiagnostics(this.program);
    if (diagnostics.length > 0) {
      diagnostics.forEach(d =>
        console.error(ts.formatDiagnostic(d, {
          getCurrentDirectory: () => process.cwd(),
          getCanonicalFileName: f => f,
          getNewLine: () => "\n",
        }))
      );
      throw new Error("TypeScript compilation failed during declaration generation");
    }

    this.program.emit(undefined, (fileName, data) => {
      if (fileName.endsWith(".d.ts") || fileName.endsWith(".d.mts")) {
        const virtualName = norm(path.resolve(fileName));
        this.inMemoryFiles.set(virtualName, data);
      }
    });

    return this.inMemoryFiles;
  }
}
