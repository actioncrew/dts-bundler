import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { DependencyGraph } from './dependency-graph';
import { DTSBundler } from './enhanced-bundler';
import { PathHierarchyResolver } from './path-hierarchy-resolver';
import { DTSGenerator } from './declaration-generator';

const norm = (p: string) => p.replace(/\\/g, '/');

export interface BundlerConfig {
  /** TypeScript configuration file path */
  tsconfig: string;
  
  /** Include comments in bundled output */
  includeComments?: boolean;
  
  /** Banner text to add at the top of each bundle */
  banner?: string;
  
  /** Custom TypeScript compiler options */
  compilerOptions?: ts.CompilerOptions;
  
  /** Patterns to exclude from bundling */
  exclude?: string[];
  
  /** Patterns to include in bundling (overrides exclude) */
  include?: string[];
  
  /** Enable verbose logging */
  verbose?: boolean;
  
  /** Validate output after bundling */
  validateOutput?: boolean;
  
  /** Custom entry point overrides */
  entryPoints?: {
    [alias: string]: string;
  };
}

export interface DtsEntryPoint { alias: string; dtsFile: string; };

const DEFAULT_CONFIG: Required<Omit<BundlerConfig, 'entryPoints'>> & { entryPoints: BundlerConfig['entryPoints'] } = {
  tsconfig: 'tsconfig.json',
  includeComments: false,
  banner: '',
  compilerOptions: {
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    allowJs: true,
    baseUrl: '.'
  },
  exclude: ['**/*.spec.ts', '**/*.test.ts', '**/node_modules/**'],
  include: ['**/*.d.ts'],
  verbose: false,
  validateOutput: true,
  entryPoints: undefined
};

export class BundlerConfigManager {
  private static readonly CONFIG_FILE = 'dts-bundler.config.json';

  static async init(projectDir: string = process.cwd()): Promise<void> {
    const configPath = path.join(projectDir, this.CONFIG_FILE);
    
    if (fs.existsSync(configPath)) {
      console.log(`Configuration file already exists: ${configPath}`);
      return;
    }

    // Create initial configuration
    const initialConfig: BundlerConfig = {
      tsconfig: DEFAULT_CONFIG.tsconfig,
      includeComments: DEFAULT_CONFIG.includeComments,
      banner: `/**\n *TypeScript Declaration Bundles\n *\n */`,
      exclude: DEFAULT_CONFIG.exclude,
      include: DEFAULT_CONFIG.include,
      verbose: DEFAULT_CONFIG.verbose,
      validateOutput: DEFAULT_CONFIG.validateOutput
    };

    await fs.promises.writeFile(
      configPath, 
      JSON.stringify(initialConfig, null, 2) + '\n', 
      'utf8'
    );

    console.log(`✅ Created configuration file: ${configPath}`);
    console.log('\nNext steps:');
    console.log('1. Edit the configuration file to match your project structure');
    console.log('2. Run: npx dts-bundler');
  }

  static load(configPath?: string, projectDir: string = process.cwd()): BundlerConfig {
    const resolvedPath = configPath || path.join(projectDir, this.CONFIG_FILE);
    
    if (!fs.existsSync(resolvedPath)) {
      console.warn(`Configuration file not found: ${resolvedPath}`);
      console.log('Run "npx dts-bundler init" to create one.');
      console.log('Using default configuration...\n');
      return { ...DEFAULT_CONFIG };
    }

    try {
      const configText = fs.readFileSync(resolvedPath, 'utf8');
      const userConfig = JSON.parse(configText) as Partial<BundlerConfig>;
      
      // Merge with defaults
      const config: BundlerConfig = {
        ...DEFAULT_CONFIG,
        ...userConfig,
        compilerOptions: {
          ...DEFAULT_CONFIG.compilerOptions,
          ...userConfig.compilerOptions
        }
      };

      // Resolve relative paths
      const configDir = path.dirname(resolvedPath);
      config.tsconfig = path.resolve(configDir, config.tsconfig);

      return config;
    } catch (error) {
      throw new Error(`Failed to load configuration from ${resolvedPath}: ${error}`);
    }
  }

  static validate(config: BundlerConfig): void {
    const errors: string[] = [];

    // Check required files exist
    if (!fs.existsSync(config.tsconfig)) {
      errors.push(`TypeScript config file not found: ${config.tsconfig}`);
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`);
    }
  }

  static getDefaultConfig(): BundlerConfig {
    return { ...DEFAULT_CONFIG };
  }
}

// Enhanced main function with configuration support
export async function main() {
  const args = process.argv.slice(2);
  
  // Handle init command
  if (args[0] === 'init') {
    await BundlerConfigManager.init();
    return;
  }

  // Parse command line arguments
  const configIndex = args.indexOf('--config');
  const configPath = configIndex !== -1 ? args[configIndex + 1] : undefined;


  try {
    // Load configuration
    const config = BundlerConfigManager.load(configPath);

    // Validate configuration
    BundlerConfigManager.validate(config);

    if (config.verbose) {
      console.log('📋 Configuration:');
      console.log(JSON.stringify(config, null, 2));
      console.log('');
    }

    // Parse TypeScript configuration
    const parsed = ts.getParsedCommandLineOfConfigFile(config.tsconfig, {}, ts.sys as any);
    if (!parsed) {
      throw new Error("Failed to parse tsconfig.json");
    }

    // Apply custom compiler options
    const compilerOptions = {
      ...parsed.options, 
      ...config.compilerOptions, 
      outDir: parsed.options.outDir ?? './dist',
      baseUrl: parsed.options.baseUrl ?? '.',
      rootDir: parsed.options.rootDir ??'.',
      declaration: true,
      emitDeclarationOnly: true,
      noEmit: false,
    };

    const dtsEntryPoints = await PathHierarchyResolver.getDtsEntryPoints(compilerOptions);

    if (dtsEntryPoints.length === 0) {
      console.error("❌ No aliases found in the monorepo");
      process.exit(1);
    }

    if (config.verbose) {
      console.log('📦 Found entry points:');
      dtsEntryPoints.forEach(ep => console.log(`  ${ep.alias} -> ${norm(path.relative(compilerOptions.outDir, ep.dtsFile!))}`));
      console.log('');
    }

    const generator = new DTSGenerator(dtsEntryPoints.map(e => e.inputFile), compilerOptions);
    const files = await generator.generate();
    
    // Build dependency graph
    const graph = new DependencyGraph(files, dtsEntryPoints.map((entry => ({ alias: entry.alias, dtsFile: entry.dtsFile! }))), compilerOptions);

    if (config.verbose) {
      console.log(`📁 Processing ${files.size} .d.ts files`);
    }

    // Check for cycles
    const cycles = graph.getCycles();
    if (cycles.length > 0) {
      console.warn("⚠️  Circular dependencies detected:");
      cycles.forEach(cycle => {
        const relativeCycle = cycle.map(f => path.relative(process.cwd(), f));
        console.warn(`  ${relativeCycle.join(' → ')}`);
      });
      console.log('');
    }

    // Get topological order
    const order = graph.topoSort();
    console.log("📦 Bundling order:");
    order.forEach(f => {
      const relative = path.relative(process.cwd(), f);
      console.log(`  - ${relative}`);
    });
    console.log('');

    // // Second pass: calculate relative paths using hierarchy
    let withRelativePaths = PathHierarchyResolver.calculateRelativePaths(dtsEntryPoints);

    // Third pass: calculate dtsFile paths based on relative paths
    withRelativePaths = withRelativePaths.map(ep => ({
      ...ep,
      inputFile: norm(path.resolve(compilerOptions.outDir!, ep.inputFile)).replace(/\.ts$/, '.d.ts'),
      dtsFile: norm(PathHierarchyResolver.calculateDtsFilePath(compilerOptions.outDir!, ep))
    }));

    // Bundle each entry in dependency order
    let bundledCount = 0;
    for (const file of order) {
      const outputFile = withRelativePaths.find(e => e.inputFile === file)!.dtsFile!;
      
      const options = {
        entryPoint: file,
        outputFile,
        includeComments: config.includeComments!,
        banner: config.banner,
        compilerOptions
      };

      const bundler = new DTSBundler(options, graph);
      await bundler.bundle();

      bundledCount++;
      const relative = path.relative(process.cwd(), outputFile);
      console.log(`✅ Bundle written to ${relative}`);
    }

    console.log(`\n🎉 Successfully bundled ${bundledCount} entries!`);
  } catch (err) {
    console.error("❌ Error bundling:", err);
    process.exit(1);
  }
}

main().catch(console.error);