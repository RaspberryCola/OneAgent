import {
  Code,
  FileText,
  Settings,
  FileImage,
  Globe,
  Database,
  Braces,
  Paintbrush,
  File,
} from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

// Extension-to-icon mapping
const EXTENSION_TO_ICON: Record<string, IconComponent> = {
  // Code files
  js: Code, mjs: Code, cjs: Code,
  ts: Code, dts: Code,
  tsx: Code, jsx: Code, vue: Code,
  py: Code, rb: Code, go: Code, rs: Code,
  java: Code, kt: Code, kts: Code, swift: Code,
  c: Code, cpp: Code, cc: Code, cxx: Code, h: Code, hpp: Code, cs: Code,
  php: Code, lua: Code, r: Code, scala: Code, groovy: Code, clj: Code,

  // Shell
  sh: Code, bash: Code, zsh: Code, ps1: Code, bat: Code,

  // Styles
  css: Paintbrush, scss: Paintbrush, sass: Paintbrush, less: Paintbrush,

  // Documentation
  md: FileText, markdown: FileText, txt: FileText, rst: FileText, tex: FileText,

  // Data
  json: Braces,

  // Config
  yaml: Settings, yml: Settings, toml: Settings, ini: Settings, env: Settings, cfg: Settings,

  // Images
  png: FileImage, jpg: FileImage, jpeg: FileImage,
  gif: FileImage, svg: FileImage, webp: FileImage,
  ico: FileImage, bmp: FileImage,

  // Web
  html: Globe, htm: Globe, xml: Globe,

  // Database
  sql: Database, graphql: Database, gql: Database,

  // Other
  prisma: Braces,
};

// Compound extensions (e.g. .d.ts)
const COMPOUND_EXTENSIONS: Record<string, IconComponent> = {
  'd.ts': Code,
};

// Special filename patterns (for files without standard extensions)
const SPECIAL_FILES: Record<string, IconComponent> = {
  'dockerfile': File,
  'makefile': File,
  'cmakelists.txt': File,
  '.gitignore': File,
  '.editorconfig': Settings,
  'package.json': Braces,
  'tsconfig.json': Braces,
  'cargo.toml': Settings,
  'pyproject.toml': Settings,
  'go.mod': Settings,
  '.env': Settings,
  '.env.example': Settings,
};

/**
 * Get appropriate icon component for a file based on its name
 */
export function getFileIcon(fileName: string): IconComponent {
  const baseName = fileName.toLowerCase().split('/').pop() || '';

  // Check special filenames first
  if (SPECIAL_FILES[baseName]) {
    return SPECIAL_FILES[baseName];
  }

  const parts = baseName.split('.');
  if (parts.length > 1) {
    const ext = parts.pop() || '';

    // Check compound extension (e.g. d.ts)
    if (parts.length > 1) {
      const compoundExt = `${parts.pop()}.${ext}`;
      if (COMPOUND_EXTENSIONS[compoundExt]) {
        return COMPOUND_EXTENSIONS[compoundExt];
      }
    }

    // Single extension
    if (EXTENSION_TO_ICON[ext]) {
      return EXTENSION_TO_ICON[ext];
    }
  }

  return File;
}
