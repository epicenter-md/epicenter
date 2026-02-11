type TarEntryInput = string | Uint8Array;
type TarFilesInput = Record<string, TarEntryInput>;
type TarUnpacked = Record<string, Uint8Array>;

const BLOCK_SIZE = 512;
const USTAR_MAGIC = 'ustar';

export type TarNamespace = {
	/** Create a tar archive (Uint8Array) from a map of filename->content */
	pack(files: TarFilesInput, options?: { mtime?: number }): Promise<Uint8Array>;
	/** Extract a tar archive into a map of filename->bytes */
	unpack(tarBytes: Uint8Array): Promise<TarUnpacked>;
};

function textToBytes(text: string): Uint8Array {
	const enc = new TextEncoder();
	return enc.encode(text);
}

function bytesToText(bytes: Uint8Array): string {
	const dec = new TextDecoder();
	return dec.decode(bytes);
}

function pad(str: string, length: number, padChar = '\0'): string {
	if (str.length >= length) return str.slice(0, length);
	return str + padChar.repeat(length - str.length);
}

function octal(value: number, length: number): string {
	const str = value.toString(8);
	const padLen = length - str.length - 1; // reserve one byte for null
	const padded = `${'0'.repeat(Math.max(0, padLen))}${str}\0`;
	return pad(padded, length, ' ');
}

function computeChecksum(block: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < block.length; i++) {
		const byte = block[i];
		if (byte === undefined) continue;
		sum += byte;
	}
	return sum;
}

function setString(
	buf: Uint8Array,
	offset: number,
	length: number,
	value: string,
) {
	for (let i = 0; i < length; i++) {
		buf[offset + i] = i < value.length ? value.charCodeAt(i) : 0; // null padding
	}
}

function createHeader(name: string, size: number, mtime: number): Uint8Array {
	const block = new Uint8Array(BLOCK_SIZE);
	// Set all with zeros (already)
	if (name.length > 100)
		throw new Error(`tar: filename too long (>${100}): ${name}`);

	setString(block, 0, 100, name); // name
	setString(block, 100, 8, pad('0000644', 8)); // mode
	setString(block, 108, 8, pad('0000000', 8)); // uid
	setString(block, 116, 8, pad('0000000', 8)); // gid
	setString(block, 124, 12, octal(size, 12)); // size
	setString(block, 136, 12, octal(mtime, 12)); // mtime
	// checksum field initially filled with spaces (0x20)
	for (let i = 148; i < 156; i++) block[i] = 0x20;
	setString(block, 156, 1, '0'); // typeflag '0' regular file
	// linkname (unused) 157-256
	setString(block, 257, 6, `${USTAR_MAGIC}\0`); // magic 'ustar\0'
	setString(block, 263, 2, '00'); // version
	// uname / gname (empty)
	// compute checksum
	const checksum = computeChecksum(block);
	const chkStr = octal(checksum, 8); // includes null + space
	setString(block, 148, 8, chkStr);
	return block;
}

function concat(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

function normalizeInput(data: TarEntryInput): Uint8Array {
	return typeof data === 'string' ? textToBytes(data) : data;
}

function padToBlock(data: Uint8Array): Uint8Array {
	if (data.length % BLOCK_SIZE === 0) return data;
	const padLen = BLOCK_SIZE - (data.length % BLOCK_SIZE);
	const padArr = new Uint8Array(padLen);
	return concat([data, padArr]);
}

function isEndBlock(block: Uint8Array): boolean {
	for (let i = 0; i < BLOCK_SIZE; i++) if (block[i] !== 0) return false;
	return true;
}

function parseOctal(bytes: Uint8Array, offset: number, length: number): number {
	let str = '';
	for (let i = 0; i < length; i++) {
		const c = bytes[offset + i];
		if (c === undefined || c === 0 || c === 32) break; // null or space
		str += String.fromCharCode(c);
	}
	if (!str) return 0;
	return Number.parseInt(str.trim(), 8) || 0;
}

function readString(bytes: Uint8Array, offset: number, length: number): string {
	let end = offset;
	const max = offset + length;
	while (end < max && bytes[end] !== 0) end++;
	return bytesToText(bytes.subarray(offset, end));
}

function packSync(files: TarFilesInput, mtimeOverride?: number): Uint8Array {
	const chunks: Uint8Array[] = [];
	const now = mtimeOverride ?? Math.floor(Date.now() / 1000);
	for (const rawName in files) {
		const name = rawName.replace(/\\+/g, '/');
		const file = files[rawName];
		if (!file) continue; // skip empty
		const content = normalizeInput(file);
		const header = createHeader(name, content.length, now);
		chunks.push(header);
		chunks.push(content);
		if (content.length % BLOCK_SIZE !== 0) {
			const padLen = BLOCK_SIZE - (content.length % BLOCK_SIZE);
			chunks.push(new Uint8Array(padLen));
		}
	}
	// two zero blocks terminator
	chunks.push(new Uint8Array(BLOCK_SIZE));
	chunks.push(new Uint8Array(BLOCK_SIZE));
	return concat(chunks);
}

function unpackSync(tarBytes: Uint8Array): TarUnpacked {
	const out: TarUnpacked = {};
	let offset = 0;
	const len = tarBytes.length;
	let zeroCount = 0;
	while (offset + BLOCK_SIZE <= len) {
		const block = tarBytes.subarray(offset, offset + BLOCK_SIZE);
		offset += BLOCK_SIZE;
		if (isEndBlock(block)) {
			zeroCount++;
			if (zeroCount === 2) break;
			continue;
		}
		zeroCount = 0;

		const name = readString(block, 0, 100);
		if (!name) continue; // skip invalid
		const size = parseOctal(block, 124, 12);
		const typeflag = block[156];
		// Only supporting regular files '0' or 0
		if (typeflag !== 48 /* '0' */ && typeflag !== 0) {
			// Skip unsupported file types; still need to advance
		}
		const fileData = tarBytes.subarray(offset, offset + size);
		out[name] = fileData.slice(); // copy
		// advance with padding
		const dataAndPad = padToBlock(fileData);
		offset += dataAndPad.length;
	}
	return out;
}

const pack: TarNamespace['pack'] = async (files, options) => {
	return packSync(files, options?.mtime);
};

const unpack: TarNamespace['unpack'] = async (bytes) => {
	return unpackSync(bytes);
};

export const TAR = {
	pack,
	unpack,
} satisfies TarNamespace;
