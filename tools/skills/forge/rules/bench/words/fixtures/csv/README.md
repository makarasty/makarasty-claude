# CSV parser and writer

Implement `src/csv.js` (ES module, no dependencies) exporting two functions.

## `parse(text, { delimiter = ',' } = {})`

Returns an array of rows; a row is an array of strings.

- Rows end with `\n` or `\r\n`. A line terminator at the very end of the text does not start another row. Empty text gives `[]`.
- A line with no characters in the middle of the text is a row with one empty field: `[""]`.
- Empty fields are `""`: `a,,c` gives `["a","","c"]`, and `a,` gives `["a",""]`.
- A field that starts with `"` is quoted. Inside it the delimiter and line breaks (`\n`, `\r\n`) are plain text and are kept exactly as written. `""` stands for one `"`. `""` alone is an empty field.
- A `"` inside an unquoted field is kept as it is: `ab"c` gives `ab"c`.
- After the closing quote of a quoted field only the delimiter, a line terminator or the end of text may follow. Anything else throws a `SyntaxError`.
- A quoted field that never closes throws a `SyntaxError`.
- Spaces are data: nothing is trimmed.
- A lone `\r` (not followed by `\n`) is not a row separator; it stays in the field.
- A leading byte order mark (U+FEFF) is dropped.
- `delimiter` is one character and not `"`, `\r` or `\n`, otherwise throw. `text` that is not a string throws a `TypeError`.

## `stringify(rows, { delimiter = ',' } = {})`

Returns text for an array of rows.

- Each value becomes `String(value)`; `null` and `undefined` become `""`.
- A field containing the delimiter, `"`, `\r` or `\n` is wrapped in quotes with every `"` doubled. Other fields are written bare.
- Rows are joined with `\r\n`, with no terminator after the last row. No rows gives `""`.
- A row that is a single empty field is written as `""` so it survives a round trip through `parse`.
- `parse(stringify(rows))` gives the rows back (as strings).

## Tests

`npm test` runs `test/visible.test.mjs`. Other cases exist that you cannot see: follow this spec, not only the visible tests.
