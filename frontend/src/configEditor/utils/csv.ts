import Papa from 'papaparse';
import type { CsvSong } from '../editorTypes.js';

function basename(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
}

export function parseCSV(text: string): CsvSong[] {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' });
  if (parsed.errors.length > 0) {
    const error = parsed.errors[0];
    throw new Error('CSV record ' + ((error.row ?? 0) + 1) + ': ' + error.message);
  }
  if (parsed.data.length === 0) throw new Error('CSV is empty.');
  const headers = parsed.data[0].map(value => value.trim().toLowerCase().replace(/[\s_-]+/g, ''));
  const column = (name: string, aliases: string[]) => {
    const matches = headers.flatMap((value, index) => aliases.includes(value) ? [index] : []);
    if (matches.length !== 1) throw new Error('CSV requires exactly one ' + name + ' column.');
    return matches[0];
  };
  const title = column('Title', ['title', 'tracktitle']);
  const artist = column('Artist', ['artist']);
  const file = column('File name', ['filename', 'filepath', 'file', 'path']);
  return parsed.data.slice(1).map((fields, index) => {
    const record = index + 2;
    if (fields.length !== headers.length) {
      throw new Error('CSV record ' + record + ' has ' + fields.length + ' columns; expected ' + headers.length + '.');
    }
    const fileName = basename(fields[file]);
    if (!fileName.trim()) throw new Error('CSV record ' + record + ' has no file name.');
    return { title: fields[title], artist: fields[artist], fileName };
  });
}
