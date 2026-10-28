/**
 * The hostile-label corpus (P5-2): strings a model, or PR content quoted by a model, could put
 * in a label, subtitle, badge or edge label. Shared by the test files; not part of the
 * package's exports. Grouped by what they try, so a failure names the technique.
 *
 * The schema refuses many of these before they reach the renderer (control and invisible
 * characters, lone surrogates); the renderer must still turn every one of them into inert text,
 * because it is the last step before the page and is also called on documents that did not come
 * through the parser (tests, the CLI, future callers).
 */
import injectionCorpus from "../../evals/fixtures/injection-corpus.json" with { type: "json" };

export type HostileCase = { technique: string; label: string };

const cases = (technique: string, labels: readonly string[]): HostileCase[] =>
  labels.map((label) => ({ technique, label }));

const BIDI = ["\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u2066", "\u2067", "\u2068"];
const ZERO_WIDTH = ["\u200B", "\u2060", "\uFEFF", "\u00AD", "\u180E", "\u034F", "\u061C"];

/** The prompt-injection corpus from P4-4: every payload, as a label. */
const injectionPayloads = (): string[] => injectionCorpus.cases.map(({ payload }) => payload);

export const HOSTILE_CORPUS: readonly HostileCase[] = [
  ...cases("markup", [
    "<script>alert(1)</script>",
    "<svg/onload=alert(1)>",
    "<img src=x onerror=alert(1)>",
    "<foreignObject><div xmlns='http://www.w3.org/1999/xhtml'>x</div></foreignObject>",
    "</text><script>alert(1)</script><text>",
    "</title></g></svg><script>alert(1)</script>",
    '</text><a href="javascript:alert(1)">x</a>',
    "<iframe srcdoc='<script>alert(1)</script>'>",
    "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    "<<script>script>alert(1)<</script>/script>",
    "<scr<script>ipt>alert(1)</script>",
    "<a xlink:href='javascript:alert(1)'>x</a>",
    "<animate attributeName=href to=javascript:alert(1) />",
    "<set attributeName=onmouseover to=alert(1) />",
    "<handler xmlns:ev='http://www.w3.org/2001/xml-events' ev:event='load'>alert(1)</handler>",
  ]),
  ...cases("entities", [
    "&amp; &lt;already&gt; escaped",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "&#60;script&#62;alert(1)&#60;/script&#62;",
    "&#x3C;script&#x3E;",
    "&xxe; &lt &#0; &#xD800; &#x110000;",
    '<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>&xxe;',
    '<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">&lol2;',
  ]),
  ...cases("attribute break-out", [
    '" onload="alert(1)',
    "' onmouseover='alert(1)",
    '"><foreignObject><div>x</div></foreignObject>',
    '" style="fill:url(javascript:alert(1))',
    '" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="javascript:alert(1)',
    '"/><script>alert(1)</script><rect x="',
    "` onload=`alert(1)",
    '="" onclick=alert(1) a="',
  ]),
  ...cases("CDATA, comments and processing instructions", [
    "]]><!--",
    "<![CDATA[<script>alert(1)</script>]]>",
    "<!-- --><script>alert(1)</script><!-- -->",
    "--><script>alert(1)</script>",
    "<?xml-stylesheet href='javascript:alert(1)'?>",
    "<?php system('id'); ?>",
    "<!DOCTYPE svg>",
    "<!ATTLIST rect onload CDATA 'alert(1)'>",
  ]),
  ...cases("URLs", [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "java\u0000script:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "vbscript:msgbox(1)",
    "url(javascript:alert(1))",
    "url(#cm-arrow-hero) url(https://evil.example/x.svg#a)",
    "https://evil.example/track.gif",
    "//evil.example/x",
  ]),
  ...cases("handlers and links", [
    "onload=alert(1)",
    "onbegin=alert(1)",
    "onfocusin=alert(1) tabindex=0 autofocus",
    "<use href='data:image/svg+xml,<svg id=x onload=alert(1)>#x'/>",
    "<use xlink:href='https://evil.example/sprite.svg#x'/>",
    "<image href='https://evil.example/pixel.png'/>",
    "<feImage href='https://evil.example/x'/>",
  ]),
  ...cases("styles", [
    "<style>@import url(https://evil.example/x.css)</style>",
    "<style>*{visibility:hidden}</style>",
    "style=display:none",
    "}*{display:none}{",
    "expression(alert(1))",
    "@import 'https://evil.example/x.css';",
  ]),
  ...cases("CSS injection through class or data attributes", [
    "cm-hero cm-critical",
    'cm-added" class="cm-hero',
    "x] , [data-node",
    '\\" ] *{}',
    'a\\"b',
  ]),
  ...cases("bidi controls", [
    ...BIDI.map((control) => `safe${control}evil.ts`),
    "\u202Etxt.exe",
    "admin\u2067\u2066 // trusted\u2069\u2069",
    "\u200E\u200Fmarks",
    "\u2069\u2069\u2069 unbalanced pops",
  ]),
  ...cases("zero-width and invisible", [
    ...ZERO_WIDTH.map((invisible) => `pay${invisible}pal`),
    "\u200B".repeat(50),
    "\u{E0041}\u{E0042}\u{E0043} tag smuggling",
    "\u2800\u3164\u115F\u1160\uFFA0 blank letters",
    "\u200D\u200D\u200D joiner run",
    `a${"\u200D\uFE0F\u200C\uFE0E".repeat(20)}b alternating joiners and selectors`,
    "selector after a space \uFE0F here",
    "selector after a letter a\uFE0F\uFE0E",
    "joiner before a mark a\u200D\u0301b",
    `${"\u{1F600}\u200D".repeat(40)}\u{1F600} joiner ratio`,
    "heart on fire \u2764\uFE0F\u200D\u{1F525} keeps its joiner",
    "trailing joiner\u200D",
    "\u200Cleading joiner",
    "👨\u200D👩\u200D👧 family keeps its joiners",
    "❤\uFE0F keeps its variation selector",
  ]),
  ...cases("controls and line breaks", [
    "a\u0000b\u0001c\u0008d\u000Be\u000Cf\u001Fg",
    "line\nbreak\r\ninside\ttabs",
    "nel\u0085separator\u2028paragraph\u2029end",
    "del\u007Fc1\u0080\u009F",
  ]),
  ...cases("surrogates and non-characters", [
    "lone high \uD800 here",
    "lone low \uDC00 here",
    "reversed pair \uDC00\uD800",
    "\uD83D",
    "non-characters \uFFFE\uFFFF\uFDD0\uFDEF\u{1FFFE}\u{10FFFF}",
    "astral 😀 𝒜 𠀀 stay",
  ]),
  ...cases("combining marks", [
    "Z\u0351\u036B\u0343\u036A\u0302\u036B\u033D\u034F\u0334\u0319\u0324\u031E\u0349\u035A\u032F\u031E\u0320\u034DA\u0334\u0335\u031C\u0330\u0354L\u0328\u0337\u0362G\u0360O",
  ]),
  ...cases("case mapping", [
    "straße",
    "ﬃ ﬄ ﬅ ligatures",
    "ΐΰ",
    "ǰ ŉ",
    "İstanbul ı",
    "ß".repeat(120),
    "ﬃ".repeat(120),
    "<script>ß</script>",
  ]),
  ...cases("length", [
    "A".repeat(10_000),
    "W".repeat(121),
    "😀".repeat(500),
    "<".repeat(2_000),
    "&".repeat(2_000),
    `${"a".repeat(399)}😀tail`,
  ]),
  ...cases("prompt injection (P4-4 corpus)", injectionPayloads()),
];

/** Ids a document might carry if it skipped the parser: none of them may reach the markup. */
export const HOSTILE_IDS: readonly string[] = [
  '" onload="alert(1)',
  "a b",
  "<script>",
  "x)url(javascript:alert(1)",
  "",
  "-leading-dash",
  "javascript:alert(1)",
  "a\u202Eb",
];

/** idPrefix values that would break out of `url(#…)` or an `id`. */
export const HOSTILE_PREFIXES: readonly string[] = [
  "",
  "CM",
  "1cm",
  "cm)",
  "cm) url(https://evil.example/x.svg#a",
  'cm"',
  "cm arrow",
  "cm\u0000",
  "x".repeat(33),
  "cm#",
  "cm/../",
];
