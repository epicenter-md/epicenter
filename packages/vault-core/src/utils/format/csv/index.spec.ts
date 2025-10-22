import { describe, it } from 'bun:test'; // Run with: node --test dist/... after build
import assert from 'node:assert/strict';
import { CSV } from './index';

describe('csv.CSV.parse', () => {
	it('parses with headers (default) into objects', () => {
		const input = 'name,age\nAlice,30\nBob,25';
		const result = CSV.parse(input);
		assert.equal(result.length, 2);
		assert.deepEqual(result[0], { name: 'Alice', age: '30' });
		assert.deepEqual(result[1], { name: 'Bob', age: '25' });
	});

	it('parses without headers into row arrays', () => {
		const input = 'name,age\nAlice,30';
		const result = CSV.parse(input, { headers: false });
		assert.deepEqual(result, [
			['name', 'age'],
			['Alice', '30'],
		]);
	});

	it('handles quotes, escaped quotes and commas', () => {
		const input = 'col1,col2\n"a,b","c""d"';
		const result = CSV.parse(input);
		assert.deepEqual(result[0], { col1: 'a,b', col2: 'c"d' });
	});

	it('parses CRLF line endings and embedded newline inside quoted field', () => {
		const input = 'h1,h2\r\n"line1\nline2",value\r\nlast,entry';
		const result = CSV.parse(input);
		assert.equal(result.length, 2);
		assert.deepEqual(result[0], { h1: 'line1\nline2', h2: 'value' });
		assert.deepEqual(result[1], { h1: 'last', h2: 'entry' });
	});
});

describe('csv.CSV.stringify', () => {
	it('stringifies object rows with headers', () => {
		const data = [
			{ name: 'Alice', age: 30 },
			{ name: 'Bob', age: 25 },
		];
		const text = CSV.stringify(data);
		const lines = text.split('\n');
		assert.equal(lines[0], 'name,age');
		assert.equal(lines[1], 'Alice,30');
		assert.equal(lines[2], 'Bob,25');
	});

	it('stringifies raw rows without headers', () => {
		const rows = [
			['name', 'age'],
			['Alice', '30'],
		];
		const text = CSV.stringify(rows, { headers: false });
		assert.equal(text, 'name,age\nAlice,30');
	});

	it('quotes fields containing delimiter, newline, quotes, or surrounding space', () => {
		const rows = [['a,comma', 'multi\nline', '"quoted"', ' spaced ']];
		const text = CSV.stringify(rows, { headers: false });
		assert.equal(text, '"a,comma","multi\nline","""quoted"""," spaced "');
	});

	it('roundtrips object rows', () => {
		const original = [
			{ a: '1', b: 'x,y' },
			{ a: '2', b: 'z' },
		];
		const csvText = CSV.stringify(original);
		const parsed = CSV.parse(csvText);
		assert.deepEqual(parsed, original);
	});
});

describe('csv options', () => {
	it('parses with custom delimiter ; and headers', () => {
		const input = 'name;age\nAlice;30\nBob;25';
		const result = CSV.parse(input, { delimiter: ';' });
		assert.deepEqual(result[0], { name: 'Alice', age: '30' });
	});

	it('stringifies with custom delimiter ;', () => {
		const data = [
			{ name: 'Alice', age: 30 },
			{ name: 'Bob', age: 25 },
		];
		const text = CSV.stringify(data, { delimiter: ';' });
		assert.equal(text.split('\n')[0], 'name;age');
	});

	it("parses with custom quote ' and escape '", () => {
		const manual = "name,quote\n'alice','say ''hi'''"; // easier to read
		const result = CSV.parse(manual, { quote: "'", escape: "'" });
		assert.deepEqual(result[0], { name: 'alice', quote: "say 'hi'" });
	});

	it('preserves whitespace when trim=false', () => {
		const input = 'name,age\n  Alice  , 30 '; // spaces around fields
		const result = CSV.parse(input, { trim: false });
		const first = result[0];
		assert.equal(first?.name, '  Alice  ');
		assert.equal(first?.age, ' 30 ');
	});

	it('includes empty line when skipEmptyLines=false', () => {
		const input = 'a,b\n1,2\n\n3,4';
		const rows = CSV.parse(input, { headers: false, skipEmptyLines: false });
		// rows: header, first, empty, last
		assert.equal(rows.length, 4);
		assert.deepEqual(rows[2], ['']); // an empty row (single empty field) due to parser logic
	});

	it('skips comment lines with custom comment char ;', () => {
		const input = ';ignored line\nname,age\nAlice,30';
		const result = CSV.parse(input, { comment: ';' });
		assert.equal(result.length, 1); // only Alice row
	});

	it('roundtrips with mixed options (custom delimiter & quote)', () => {
		const data = [{ path: 'C;\\temp', text: "O'hara" }];
		const csvText = CSV.stringify(data, {
			delimiter: ';',
			quote: "'",
			escape: "'",
		});
		const parsed = CSV.parse(csvText, {
			delimiter: ';',
			quote: "'",
			escape: "'",
		});
		assert.deepEqual(parsed, [{ path: 'C;\\temp', text: "O'hara" }]);
	});

	it('handles very large field containing delimiters and quotes', () => {
		const longSegment = 'segment,'; // contains delimiter
		const repeated = `${Array.from({ length: 500 }, () => longSegment).join('')}"tail"`;
		const data = [{ big: repeated, other: 'x' }];
		const csvText = CSV.stringify(data); // default options
		// Ensure it quoted the first line's big field (starts with header line then quoted field)
		const lines = csvText.split('\n');
		assert.ok(lines[1]?.startsWith('"'));
		const parsed = CSV.parse(csvText);
		assert.equal(parsed[0]?.big, repeated);
		assert.equal(parsed[0]?.other, 'x');
	});

	it('treats comment char inside quotes as literal text', () => {
		const input =
			'#comment line\nname,remark\nAlice,"#not a comment"\nBob,valid';
		const parsed = CSV.parse(input, { comment: '#' });
		assert.equal(parsed.length, 2); // two data rows
		assert.deepEqual(parsed[0], { name: 'Alice', remark: '#not a comment' });
		assert.deepEqual(parsed[1], { name: 'Bob', remark: 'valid' });
	});
});
