# Derived rule set

Rules taken from the Google Developer Documentation Style Guide. Apply only the categories the artifact actually uses. For a disputed word, see `word-list.md`. For anything not covered, fetch the relevant page from `official-pages.md`.

## Voice and tone

- Write as a knowledgeable friend who understands what the developer wants to do. Conversational, friendly, respectful, and never frivolous.
- Cut buzzwords, figurative language, pop culture references, and internet slang (`tl;dr`, `ymmv`, `RTFM`).
- Cut filler openers: "please note", "at this time", "it should be noted that".
- Do not phrase actions as "let's".
- Do not use "please" in instructions. Reserve it for when you are genuinely inconveniencing the reader.
- Excessive exclamation points read as frivolous. Use at most one, and usually none.
- Read the draft aloud. If it sounds stilted or breathless, fix it.

Calibration: "Dude! This API is totally awesome!" is too informal. "The API may enable acquisition of information pertaining to user preferences." is too formal. "This API lets you collect data about user preferences." is right.

## Person, voice, tense

- Second person `you` for the reader. Imperative mood for steps, where `you` is implied.
- Third person for what the software does and for end users who are not the reader.
- First person plural only for the authoring organization, with an unambiguous antecedent: "We recommend", "contact our sales team".
- State who your `you` is near the top when the audience could be read more than one way.
- Active voice by default. Passive is acceptable in three cases: the object is the point ("The file is saved"), the actor is irrelevant ("The database was purged in January"), or naming the actor would blame the reader ("Over 50 conflicts were found").
- Present tense for general behavior. Future tense only for something that genuinely happens later ("The file will be archived the next time the backup runs") or for an async operation.
- Do not use hypothetical `would`. Rewrite as a conditional.

## Prescriptive documentation

- Recommend a way to accomplish the goal. Do not hand the reader a menu.
- Give the command for the most common use case, not the exhaustive form.
- Required: "must", or a bare imperative.
- Recommended: "We recommend" or "Google recommends".
- Optional: "can".
- Expected outcome: state it plainly ("The process returns 10 items").
- Possible outcome: "might" or "can".
- Avoid `should` in prescriptive text. It leaves the reader unsure whether the action is required.
- When more than one method is genuinely needed, split them across pages, headings, or tabs rather than interleaving. Prefer the keyboard-accessible path.

## Claims and time

- No superlatives or absolutes you cannot verify: `best`, `simplest`, `fastest`, `always`, `never`.
- `ensure` and `guarantee` only when the thing is truly guaranteed. Prefer "helps prevent" and "is designed for".
- No unqualified security claims. A breach makes them false retroactively.
- No competitive claims that product changes can invalidate.
- Do not pre-announce features, timelines, or roadmap.
- Timeless documentation drops `currently`, `presently`, `at present`, `as of this writing`, `new`, `newer`, `old`, `older`, `now`, `soon`, `latest`, `eventually`, `in the future`, `does not yet`, and `existing`. Release notes, blog posts, and press releases are exempt.
- If newness is load-bearing, anchor it: "The January 14, 2021 release of BigQuery includes a resource panel."
- Paraphrase and link to third-party material rather than copying it. Keep required attribution.

## Structure and headings

- Sentence case for titles, headings, captions, labels, list items, and table headers.
- Task heading: bare imperative verb. "Create an instance", not "Creating an instance".
- Concept heading: noun phrase. "Migration to Google Cloud", not "Migrating to Google Cloud".
- No `-ing` opener. It inflates character count and translates inconsistently. Established exceptions like "Billing" and "Pricing" stand.
- One h1 per page. Do not skip levels. Do not leave a heading with no content under it.
- Keep heading punctuation simple. Complicated punctuation signals a heading trying to do too much.
- No sequence numbers, no links, and no bare code items in headings. If a code item is unavoidable, add a descriptive noun.
- Do not repeat the page title as a section heading.
- Prefix a conditional section with `Optional:`.
- Introducing subsections, write "the following sections", not "this section" or "these sections".
- One idea per paragraph, most important information first.

## Lists

- Numbered list for a sequence. Bulleted list for unordered items. Description list for term and definition pairs.
- Introduce every list with a complete sentence. Use "the following". End with a colon when the list follows immediately, a period when other material intervenes.
- Capitalize the first word of each item unless case is significant.
- End items with a period, except when they are single words, verbless fragments, entirely code font, or link text. Be consistent within a list; rewrite for parallelism if punctuation would vary.
- Keep items grammatically parallel.
- Never write a one-item list.
- Nested sequences use lowercase letters, then lowercase Roman numerals.
- Use `<p>` for multiple paragraphs in an item, never `<br>`.
- Do not write "etc." or "and so on". Say what the list omits.
- Serial comma in paragraph-style lists.

## Procedures

- Numbered steps for a task. Sub-steps use a, b, c. Sub-sub-steps use i, ii, iii.
- One action per step. Combine tightly coupled clicks with angle brackets: "Click **File > New > Document**".
- Location first, then action: "In Google Docs, click **File > New > Document**".
- Goal first, then action: "To start a new document, click **File > New > Document**".
- Mark a nonrequired step as `Optional:` at the start. Not `(Optional)`.
- State the action, then the result, in the same paragraph: "Click **Run**. The query results appear after the query runs."
- Give a justification when a step's importance is not obvious: "Store the private key in a secure location. You need it later."
- Introduce a procedure with context beyond the heading. Restate context in the first step when several procedures sit under separate headings.
- Format a single-step procedure as a bullet.
- Include pressing **Enter** in the step when it is required. Leave keyboard shortcuts out of steps.
- State prerequisites up front.
- Reference an earlier procedure rather than repeating it.
- No directional language. No "please". Avoid "run the following command" when you can name what the command does.

## UI elements and interaction

- Bold every visible UI label. Match its capitalization. If labels are inconsistent or all uppercase, use sentence case. Drop trailing ellipses from the label.
- Do not use code font for a UI element unless it independently qualifies for code font.
- Verbs: `click` (mouse), `tap` (touch), `select` (options and checkboxes), `clear` (deselect a checkbox), `enter` (text), `press` (keys), `drag`, `choose`, `enable` (turn a feature on), `hold the pointer over` (hover).
- Not `click on`, `check`, `uncheck`, `deselect`, or `hit`.
- Do not treat a UI element as a verb: "Click **Save**", not "**Save** the settings".
- Prepositions: `in` a dialog, field, list, menu, pane, or window. `on` a page, tab, or toolbar.
- Navigation path: wrap the whole sequence in one bold tag, with a nonbreaking space before the angle bracket, and label the bracket for screen readers: `**File&nbsp;<span aria-label="and then">></span>&nbsp;Open**`.
- Keys use `<kbd>`. Spell out modifiers (Control, Command, Option, Shift), uppercase letter keys, and join with `+`: `<kbd>Control+Shift+?</kbd>`. Cover platforms as "Press Control+C (or Command+C on macOS)".
- No slang for UI: not "hamburger icon", not "zippy".

## Code in text

Code font for: attribute names and values, class names, command output, command-line utilities, data types, database columns and rows, DNS record types, element names, enum names, environment variables, filenames and paths, HTTP content types, HTTP status codes, IAM role names, language keywords, method and function names, namespace aliases, package names, placeholders, port numbers, query parameters, strings inside commands or code, and UI text rendered from input the reader typed.

Ordinary font for: product, service, and organization names; domain names; and URLs the reader opens in a browser. Use code font for these only when they appear as literal input or output.

- `true` and `false` take code font as data-type values, ordinary font when describing an evaluated condition.
- The command `gcc` takes code font; the GCC project does not.
- Email addresses take code font only when they are literal input or output.
- Never inflect a code element. Add a noun and inflect that instead: "The `ADDRESS` constant's value", not "`ADDRESS`'s value". "Send a `POST` request", not "`POST` the data".
- Drop the class name from a method reference unless it prevents ambiguity: "the `get` method".
- HTTP status codes: "an HTTP `400 Bad Request` status code". Ranges: "an HTTP `2xx` or `400` status code".
- Do not put quotation marks around code unless the quotes are part of the code.

## Code samples

- Introduce every sample with a complete sentence. Colon when it precedes the sample directly, period when notes intervene.
- Mark samples as preformatted, and follow the relevant language style guide for indentation and conventions.
- Wrap at 80 characters.
- Show an omission with the language's comment syntax. Do not use three dots or an ellipsis character.
- Do not make a block containing omissions click-to-copy.
- Samples must run and must be correct.

## Command-line syntax

- Square brackets mark an optional argument. Bracket each optional argument separately: `gcloud dns GROUP [GLOBAL_FLAG] [FILENAME]`.
- Curly braces with pipes mark a required choice of exactly one: `{FILE_1|FILE_2}`.
- Three dots with no spaces mark a repeatable argument: `[GLOBAL_FLAG ...]`.
- Break lines over 80 characters with a trailing backslash on Linux or caret on Windows, and indent the continuation four spaces.
- Keep optional arguments, alternatives, and ellipses out of click-to-copy examples. Those characters break a pasted command. Use separate blocks instead.
- Include output only when it adds value: "The output is similar to the following:".
- Follow every command with a description of its placeholders.

## Placeholders

- `UPPER_SNAKE_CASE`. Not `API_name`, not `API-name`, not lowercase.
- No possessive prefix: `MY_API_NAME` and `YOUR_PROJECT` are wrong.
- Do not use `x` or `xxx` as a placeholder. Standard contexts such as HTTP `2xx` are fine.
- Inline in Markdown: `` *`PLACEHOLDER_NAME`* ``. In HTML: `<code><var>PLACEHOLDER_NAME</var></code>`.
- One placeholder: "Replace `PLACEHOLDER` with a description of the value."
- Several placeholders: "Replace the following:" then one entry per placeholder, in the order they appear, each formatted as `` `PLACEHOLDER_NAME` `` followed by a lowercase description.
- Explain output values the same way: "This output includes the following values:".
- Avoid `foo`, `bar`, and `baz`. Use meaningful names.

## API reference and code comments

- Every class, constant, method, and parameter gets a description.
- Class or interface: state the purpose in the first sentence without repeating the class name. No "This class does ...".
- Method descriptions use present tense third person and start with a verb: "Adds a new bird and returns the ID", "Checks whether ..." (boolean getter), "Gets the ..." (non-boolean getter), "Sets the ...", "Updates the ...", "Deletes the ...", "Registers ..." (callback registration), "Called by ..." (callback), "Creates a ..." (convenience constructor).
- Parameters: capitalize, end with a period, and start non-boolean descriptions with "The" or "A".
- Boolean parameter that drives an action: "If true, validates the SSL certificate before proceeding. If false, trusts the certificate without validating it."
- Boolean parameter that reports state: "True if the zoom is set; false otherwise."
- Defaults: "Default: VALUE".
- Return values: non-boolean starts with "The". Boolean uses "True if ...; false otherwise."
- Include a 5 to 20 line sample at the top of each page.
- Link API names to their reference pages, in code font.
- Document dependencies, required permissions, and exception behavior.
- Deprecation states the replacement first: "Deprecated. Use X instead." Reasoning follows.

## Tables

- Use a table for items carrying three or more related pieces of data. Use a list for a single unit, and a description list or table for pairs.
- Do not use tables for layout, code snippets, a long one-dimensional list split into columns, or inside a numbered procedure.
- Introduce every table with a complete sentence describing its purpose. Screen readers may not announce it.
- `th` for the first row and first column only, with a `scope` attribute. Do not style headers by hand.
- Column heads: sentence case, concise, no ending punctuation of any kind.
- Caption format when a page has several tables: **Table NUMBER.** DESCRIPTION, sentence case, no trailing period.
- Refer to a table by number rather than by position.
- `<p>` for multiple paragraphs in a cell, never `<br>`.
- Avoid `colspan` and `rowspan`.
- Sort rows logically or alphabetically. Keep the table responsive.

## Figures and images

- Use an image only when it explains something words handle poorly.
- Never use an image of code, text, or terminal output. Use real text.
- Alt text: 155 characters or fewer, a full sentence or noun phrase, with end punctuation. No "Image of" or "Photo of", no ALL CAPS. Decorative images take `alt=""`.
- Never carry new information in an image alone.
- Caption format: **Figure NUMBER.** DESCRIPTION. Complete sentences with end punctuation. Reference as "in figure 1", never "above".
- Screenshots: consistent OS and appearance, cropped to the relevant area, no personally identifying information, flattened on export, no image maps.
- Minimize text inside a figure. Where it is unavoidable, keep it short, sentence case, with full trademarked product names, and use numbered callouts.
- SVG for diagrams, PNG acceptable. MP4 rather than animated GIF.
- High resolution uses `srcset` with `1x` and `2x`, where the `2x` file is exactly double and named `BASENAME_2x.EXTENSION`. Do not upscale.
- Do not position or center images inline with `style`. Do not nest `img` inside `p`.

## Accessibility

- Links must make sense read out of context.
- Announce unexpected link behavior, such as opening a new tab or starting a download.
- No directional language: `above`, `below`, `right-hand side`. Use `preceding` and `following`, or name the label. Add a labeled screenshot when a control is genuinely hard to find.
- Never rely on color, size, position, or sound alone. Pair a color or icon state change with a text label.
- The document must work without color, without images, and without sound.
- Descriptive headings, hierarchical levels, none empty.
- People-first language by default: "people with disabilities", "nondisabled people", "uses a wheelchair", "living with". Not "the disabled", "normal people", "suffering from", "wheelchair-bound". Some communities prefer identity-first language; check before assuming.

## Global audience

- No idioms or colloquialisms: "ballpark figure", "back burner", "hang in there".
- No culture-specific references: holidays, sports, seasons. August is not summer everywhere.
- No humor. It rarely survives translation.
- Use common contractions sparingly and skip uncommon ones.
- Keep relative pronouns: "the rules that you defined", not "the rules you defined".
- Prefer what the reader can do over what they cannot.
- Replace an ambiguous pronoun with the noun it refers to.
- Use diverse example names.
- Use the same term, capitalization, and sentence pattern for the same concept every time. A translator reads a variation as a different concept.

## Inclusive language

| Not this | This |
| --- | --- |
| whitelist, blacklist | allowlist, blocklist, denylist |
| master, slave | primary and replica, controller and replica, parent and replica, main |
| sanity check | final check for completeness and clarity |
| dummy variable | placeholder |
| crazy, insane | baffling, unexpected |
| blind to | ignores, unaware of, disregards |
| cripples | slows down |
| hangs | does not respond |
| hit (a UI target) | click, press |
| kill, abort, terminate | stop, exit, cancel, end |
| man-hours, mankind | person-hours, humanity |
| native (of a person) | a precise term such as built-in for software |
| first-class citizen | a neutral, specific description |

For an established problematic term the reader will search for, name it once in parentheses on first mention, then use the inclusive replacement.

## Jargon

- Jargon covers group-specific figurative terms (`camel case`, `swim lane`, `break-glass procedure`) and overloaded ones (`solution`, `support`, `workload`).
- Preferred handling, in order: write around it; replace it with a specific term (`import` or `load` for `ingest`, `pre-built` for `off-the-shelf`); define it in plain language in parentheses on first use; or define it once and reuse it when it recurs.
- Some industry jargon is worth keeping for search. Define it rather than dropping it.
- In code samples, use jargon only in direct reference to code items, in code font, with plain language nearby.

## Punctuation

- Serial comma before the final `and` or `or`.
- Comma after an introductory word or phrase.
- Comma before a coordinating conjunction joining two independent clauses, unless both are very short.
- Comma before `which` starting a nonrestrictive clause. No comma before `because` unless it starts a nonrestrictive clause.
- Semicolon, period, or dash before a conjunctive adverb (`however`, `therefore`, `otherwise`), then a comma after it.
- Em dash with no surrounding spaces marks a break in a sentence. Do not use en dashes; use a hyphen or the word `to`. In this repo, `AGENTS.md` bans both dash characters, so restructure instead.
- Do not use a dash to separate an item from its description. Use a colon, a period, or a description list.
- Hyphenate a two-word compound modifier before a noun ("a well-designed app"). Do not hyphenate after the verb ("the app is well designed"). Do not hyphenate an `-ly` adverb ("publicly available"). Restructure rather than stacking a three-word modifier.
- Prefixes usually close up (`metadata`, `preprocessing`). Hyphenate after `self-` and `cross-`, before a capitalized noun or number (`non-Google`, `post-2000`), and to prevent misreading (`re-mark`).
- Closed compounds: `webpage`, `hostname`, `workaround`. Always hyphenated: `on-premises`, `cloud-based`, `customer-facing`.

## Capitalization and abbreviations

- Standard American English capitalization. Before capitalizing a word, have a reason.
- Sentence case for titles, headings, captions, labels, list items, table elements, and glossary definitions.
- Lowercase after a colon, unless a proper noun, heading, quotation, or a label such as `Note` follows.
- Capitalize only the first element of a hyphenated word starting a sentence, unless a later element is a proper noun.
- No ALL CAPS outside official names, standard abbreviations, and code. No camel case outside official names and code.
- Do not name a casing style. Describe the requirement and give an example.
- Spell out an abbreviation on first use, italicizing both the full term and the abbreviation: *Border Gateway Protocol* (*BGP*). Use the abbreviation afterward.
- Do not expand well-known abbreviations: AI, API, DVD, HTML, PC, RAM, REST, URL, USB, file formats, units. Do not expand one where the expansion does not help.
- `a` or `an` follows pronunciation: "a SQL", "a FHIR", "an SAP".
- Pluralize abbreviations as ordinary words, adding `es` after s, sh, ch, or x.
- No `i.e.`, `e.g.`, `tl;dr`, `ymmv`, or `RTFM`.
- No periods in acronyms and initialisms, or in country and state abbreviations. Periods in shortened words such as `Dr.`.

## Numbers, dates, and times

- Spell out zero through nine in ordinary prose. Numerals for 10 and up.
- Numerals regardless of size for versions, technical quantities, page and step numbers, prices, percentages, dimensions, and math.
- Spell out a number that starts a sentence, or rewrite so it does not.
- Spell out ordinals: `first`, `fifth`, `twelfth`.
- Comma-group four or more digits: `1,532,784`. Period as the decimal point.
- Prefer decimals to fractions. `40%` with the symbol.
- Dimensions use a lowercase `x` with no spaces: `192x192`.
- Dates in prose: `January 19, 2017`, or `Tuesday, April 27, 2021`, or `January 2017` with no comma. Add a comma after the year mid-sentence for a full date.
- Numeric-only dates use ISO 8601: `2017-04-15`. Never `04/05/09`.
- Table and heading abbreviations: `Mon, Sep 3, 2018`, no periods, applied consistently.
- Times use the 12-hour clock with capitalized AM and PM: `3 PM`, `3:45 PM`. Use `noon` and `midnight`. Match a 24-hour UI where consistency demands it.
- Minimize time zones. Prefer "10 AM your local time". Spell out the zone with a UTC offset: `US and Canadian Pacific Standard Time (UTC-8)`. Never abbreviate a zone name.
- No seasons. Use months or quarters.

## Notices

- Four types. `Note`: useful, skippable. `Caution`: proceed carefully. `Warning`: do not do this, reserved for irreversible loss, security, or cost. `Success`: an error-free status, in interactive content only.
- Do not use a notice for a cross-reference, a prerequisite, a prior step, procedural content, or anything required for success. That belongs in the main text.
- Do not use a notice for information that flows naturally from the sentence before it.
- Do not stack notices, and do not use many on one page. They stop registering.

## Example data

- Domains: `example.com`, `example.org`, `example.net`, or Google's reserved `altostrat.com`, `examplepetstore.com`, `cymbalgroup.com`.
- Email: an example name at an example domain, such as `dana@example.com`. Generic addresses like `support@example.net` are fine.
- Person names, from the guide's list: Alex, Amal, Ariel, Bola, Charlie, Cruz, Dana, Dani, Hao, Ira, Izumi, Jie, Kai, Kalani, Kim, Kiran, Lee, Lucian, Luka, Mahan, Noam, Nur, Quinn, Raha, Rosario, Sasha, Tal, Taylor, Tristan, Yuri. Add an initial for a surname (`Quinn N.`). Use gender-neutral pronouns unless gender is material.
- Companies: "Example Organization" and variants.
- Phone: `800-555-0100` through `800-555-0199`.
- IPv4: `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`. IPv6: `2001:db8::/32`.
- Never use real personal data in an example.

## Markdown and HTML

- Markdown when readability of the source matters. HTML when you need semantic tagging or an effect Markdown cannot express, such as `<code>` around a nonbreaking space.
- Follow whatever the team or template already uses.
- Reserve underlining for links.
- Do not override font styles inline.
- Italics for a term being defined or used as a word, for a book or long-work title, for mathematical variables (`*x*` + `*y*` = 3, operators upright), and for version variables (version 1.4.*x*).
