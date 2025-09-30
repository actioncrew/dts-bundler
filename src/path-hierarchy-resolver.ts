import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export interface DtsEntryPoint {
  alias: string;
  inputFile: string;
  dtsFile?: string;
  aliasSegments: string[];
  targetSegments: string[];
  relativePath?: string;
  parentAlias?: string;
}

interface PathNode {
  alias: string;
  segments: string[];
  children: PathNode[];
  parent?: PathNode;
  dtsFile?: string;
}

const norm = (p: string) => p.replace(/\\/g, '/');

export class PathHierarchyResolver {

  /**
   * Find the longest common prefix between two segment arrays
   */
  static findCommonPrefix(segments1: string[], segments2: string[]): string[] {
    const common: string[] = [];
    const minLength = Math.min(segments1.length, segments2.length);

    for (let i = 0; i < minLength; i++) {
      if (segments1[i] === segments2[i]) {
        common.push(segments1[i]);
      } else {
        break;
      }
    }

    return common;
  }

  /**
   * Build a hierarchy tree from path segments
   */
  static buildHierarchy(entryPoints: DtsEntryPoint[]): PathNode[] {
    const nodes: PathNode[] = entryPoints.map(ep => ({
      alias: ep.alias,
      segments: ep.aliasSegments,
      children: [],
      dtsFile: ep.dtsFile
    }));

    // Sort by segment length (parents come first)
    nodes.sort((a, b) => a.segments.length - b.segments.length);

    // Build parent-child relationships
    for (let i = 0; i < nodes.length; i++) {
      const current = nodes[i];

      // Find the best parent (longest common prefix)
      let bestParent: PathNode | undefined;
      let longestPrefixLength = 0;

      for (let j = 0; j < i; j++) {
        const candidate = nodes[j];
        const commonPrefix = this.findCommonPrefix(current.segments, candidate.segments);

        // Parent must have all segments match as prefix
        if (commonPrefix.length === candidate.segments.length &&
          commonPrefix.length > longestPrefixLength &&
          commonPrefix.length < current.segments.length) {
          bestParent = candidate;
          longestPrefixLength = commonPrefix.length;
        }
      }

      if (bestParent) {
        current.parent = bestParent;
        bestParent.children.push(current);
      }
    }

    // Return root nodes (no parents)
    return nodes.filter(node => !node.parent);
  }

  /**
   * Calculate relative paths based on hierarchy
   */
  static calculateRelativePaths(entryPoints: DtsEntryPoint[]): DtsEntryPoint[] {
    const hierarchy = this.buildHierarchy(entryPoints);
    const result: DtsEntryPoint[] = [];

    function processNode(node: PathNode, parentRelativePath: string = '') {
      let relativePath: string;
      let parentAlias: string | undefined;

      if (node.parent) {
        // Relative path should be parent's relativePath + remaining segments
        const remainingSegments = node.segments.slice(node.parent.segments.length);
        relativePath =
          remainingSegments.length > 0
            ? path.posix.join(parentRelativePath, ...remainingSegments)
            : parentRelativePath || '.';
        parentAlias = node.parent.alias;
      } else {
        // Root node
        relativePath = '.';
      }

      // Find the original entry point and update it
      const original = entryPoints.find(ep => ep.alias === node.alias);
      if (original) {
        result.push({
          ...original,
          relativePath: relativePath.startsWith('.') ? relativePath : './' + relativePath,
          parentAlias
        });
      }

      // Process children
      node.children.forEach(child => processNode(child, relativePath));
    }

    hierarchy.forEach(root => processNode(root));
    return result;
  }

  /**
   * Main entry point resolution with hierarchy
   */
  static getDtsEntryPoints(compilerOptions: ts.CompilerOptions): DtsEntryPoint[] {
    const outDir = compilerOptions.outDir || 'dist';
    const baseUrl = compilerOptions.baseUrl || '.';
    const paths = compilerOptions.paths || {};

    const entryPoints: DtsEntryPoint[] = [];

    // First pass: split paths and create entry point definitions
    for (const [alias, targets] of Object.entries(paths)) {
      if (!targets) continue;
      if (!Array.isArray(targets) || !targets.length) continue;

      const target = norm(targets[0]) as string;

      // Handle wildcard patterns
      if (alias.includes('*')) {
        // For wildcard patterns, we need to discover actual modules
        const expandedEntries = this.expandWildcardPattern(alias, target, baseUrl, outDir);
        entryPoints.push(...expandedEntries);
      } else {
        // Handle exact aliases (non-wildcard)
        const aliasSegments = alias.split('/').filter(s => s);
        const targetSegments = target.split('/').filter(s => s);

        entryPoints.push({
          alias,
          inputFile: target,
          dtsFile: norm(path.resolve(outDir, target.replace(/\.ts$/, '.d.ts'))),
          aliasSegments,
          targetSegments
        });
      }
    }

    // // Second pass: calculate relative paths using hierarchy
    // const withRelativePaths = this.calculateRelativePaths(entryPoints);

    // // Third pass: calculate dtsFile paths based on relative paths
    // return withRelativePaths.map(ep => ({
    //   ...ep,
    //   dtsFile: norm(this.calculateDtsFilePath(outDir, ep))
    // }));
    return entryPoints;
  }

  /**
   * Calculate the actual .d.ts file path based on relative path and output directory
   */
  static calculateDtsFilePath(outDir: string, entryPoint: DtsEntryPoint): string {
    let relativePath = entryPoint.relativePath || '.';

    if (relativePath === '.') {
      // Root entry - look for index.d.ts in the base directory
      return path.resolve(outDir, 'index.d.ts');
    }

    // Remove ./ prefix and resolve relative to outDir
    const cleanPath = relativePath.replace(/^\.\//, '');
    const targetDir = path.resolve(outDir, cleanPath);

    // Always look for index.d.ts in the target directory
    return path.resolve(targetDir, 'index.d.ts');
  }

  /**
   * Expand wildcard patterns to find actual entry points
   */
  private static expandWildcardPattern(
    aliasPattern: string,
    targetPattern: string,
    baseUrl: string,
    outDir: string
  ): DtsEntryPoint[] {
    const entryPoints: DtsEntryPoint[] = [];

    // Remove asterisks to get base paths
    const aliasBase = aliasPattern.replace('/*', '').replace('*', '');
    const targetBase = targetPattern.replace('/*', '').replace('*', '');

    // Resolve target base path
    const resolvedTargetBase = path.isAbsolute(targetBase)
      ? targetBase
      : path.resolve(baseUrl, targetBase);

    // Map to output directory
    const relativeBase = path.relative(baseUrl, resolvedTargetBase);
    const distBase = path.resolve(outDir, relativeBase);

    // Find all subdirectories/files that could match the pattern
    const discovered = this.discoverMatchingPaths(distBase, aliasBase);

    for (const match of discovered) {
      const aliasSegments = match.alias.split('/').filter(s => s);
      const targetSegments = match.targetPath.split('/').filter(s => s);

      entryPoints.push({
        alias: match.alias,
        inputFile: match.targetPath,
        dtsFile: '', // Will be calculated later
        aliasSegments,
        targetSegments
      });
    }

    return entryPoints;
  }

  /**
   * Discover all matching paths for a wildcard pattern
   */
  private static discoverMatchingPaths(distBase: string, aliasBase: string): Array<{
    alias: string;
    targetPath: string;
  }> {
    const matches: Array<{ alias: string; targetPath: string; }> = [];

    if (!fs.existsSync(distBase)) {
      return matches;
    }

    // Recursively find all directories with index.d.ts files
    const findValidDirs = (dir: string, relativePath: string = ''): void => {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;

      try {
        const entries = fs.readdirSync(dir);

        // Check if current directory has index.d.ts
        if (entries.includes('index.d.ts')) {
          const alias = relativePath
            ? `${aliasBase}/${relativePath}`
            : aliasBase;

          matches.push({
            alias,
            targetPath: relativePath
          });
        }

        // Continue searching subdirectories
        for (const entry of entries) {
          const fullPath = path.join(dir, entry);
          const newRelativePath = relativePath ? `${relativePath}/${entry}` : entry;

          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              findValidDirs(fullPath, newRelativePath);
            }
          } catch {
            // Skip files we can't read
            continue;
          }
        }
      } catch {
        // Skip directories we can't read
        return;
      }
    };

    findValidDirs(distBase);
    return matches;
  }
}
