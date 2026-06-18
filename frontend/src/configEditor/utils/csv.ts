import type { CsvSong } from '../editorTypes.js';

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function basename(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
}

export function parseCSV(text: string): CsvSong[] {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  // Skip the header row
  return lines.slice(1).map(line => {
    const fields = parseCSVLine(line);
    return {
      title: fields[1] ?? '',
      artist: fields[2] ?? '',
      fileName: basename(fields[11] ?? ''),
    };
  }).filter(row => row.fileName.length > 0);
}
