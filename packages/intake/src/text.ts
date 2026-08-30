import { ProjectContractError } from "@ai-dev-os/project";
import {
  INTAKE_DIAGNOSTIC_ROOTS,
  IntakeError,
  refuseIntake,
  type IntakeDiagnosticRoot,
} from "./errors.js";
import { INTAKE_LIMITS } from "./contracts.js";

const BIDI_PATTERN = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const ZERO_WIDTH_PATTERN = /[\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200D\u2060-\u2065\u206A-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8\u{13430}-\u{13455}\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/u;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const LOCAL_PATH_PATTERNS = Object.freeze([
  /(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]/u,
  /(?:^|[^A-Za-z0-9_./\\-])\\[\\/]*(?:$|[^\\/\s"'`<>|]+(?:[\\/][^\\/\s"'`<>|]+)*)/u,
  /(?:^|[^A-Za-z0-9_./\\-])\/[^/\s"'`<>|]+(?:\/[^/\s"'`<>|]+)*/u,
  /(?:^|[^A-Za-z0-9_])file:\/{3}[^\s]+/iu,
  /(?:^|[^A-Za-z0-9_./\\-])[\\/]+(?=$|[^A-Za-z0-9_./\\-])/u,
] as const);
const FORWARD_UNC_PATTERN = /\/\/[^/\s"'`<>|]+(?:[\\/][^\\/\s"'`<>|]+)*/gu;
const PROTECTED_NAMED_IDENTIFIERS = Object.freeze([
  Object.freeze({ prefix: "brf", separator: ":", bodyPunctuation: "._:-" }),
  Object.freeze({ prefix: "prj", separator: ":", bodyPunctuation: "._:-" }),
  Object.freeze({ prefix: "dec", separator: ":", bodyPunctuation: "._:-" }),
  Object.freeze({ prefix: "thr", separator: ":", bodyPunctuation: "._:-" }),
  Object.freeze({ prefix: "intake-evidence", separator: ":", bodyPunctuation: "._:-" }),
  Object.freeze({ prefix: "project-brief", separator: ":", bodyPunctuation: "._:-" }),
  Object.freeze({ prefix: "sha256", separator: ":", bodyPunctuation: "" }),
  Object.freeze({ prefix: "intake", separator: ".", bodyPunctuation: "._-" }),
] as const);
const UNICODE_MARK_PATTERN = /^\p{M}$/u;
const CONFUSABLE_DATA_IDENTITY = Object.freeze({
  standard: "Unicode UTS #39" as const,
  version: "17.0.0" as const,
  date: "2025-07-22" as const,
  sourceSha256: "091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a" as const,
});
// Generated C8-scoped reverse classes from Unicode 17.0.0 UTS #39
// confusables.txt (identity above), with the narrow repository-specific
// supplements recorded in ADR 0042.
const PROTECTED_CONFUSABLE_EQUIVALENTS = Object.freeze({
  "0": "\u{39F}\u{41E}\u{555}\u{7C0}\u{B20}\u{CE6}\u{12D0}\u{2070}\u{2080}\u{24EA}\u{2C9E}\u{2D54}" +
    "\u{3007}\u{A4F3}\u{FF10}\u{FF2F}\u{10292}\u{102AB}\u{10404}\u{104C2}\u{10516}\u{118B5}\u{118E0}\u{11DE0}" +
    "\u{1CCE4}\u{1CCF0}\u{1D40E}\u{1D442}\u{1D476}\u{1D4AA}\u{1D4DE}\u{1D512}\u{1D546}\u{1D57A}\u{1D5AE}\u{1D5E2}" +
    "\u{1D616}\u{1D64A}\u{1D67E}\u{1D6B6}\u{1D6F0}\u{1D72A}\u{1D764}\u{1D79E}\u{1D7CE}\u{1D7D8}\u{1D7E2}\u{1D7EC}" +
    "\u{1D7F6}\u{1FBF0}",
  "1": "\u{49}\u{7C}\u{B9}\u{196}\u{1C0}\u{399}\u{406}\u{4C0}\u{4CF}\u{5C0}\u{5D5}\u{5DF}" +
    "\u{627}\u{661}\u{6F1}\u{7CA}\u{16C1}\u{2081}\u{2110}\u{2111}\u{2113}\u{2160}\u{217C}\u{2223}" +
    "\u{23FD}\u{2460}\u{2C92}\u{2D4F}\u{A4F2}\u{FE8D}\u{FE8E}\u{FF11}\u{FF29}\u{FF4C}\u{FFE8}\u{1028A}" +
    "\u{10309}\u{10320}\u{11DDA}\u{11DE1}\u{16EAA}\u{16F28}\u{1CCDE}\u{1CCF1}\u{1D408}\u{1D425}\u{1D43C}\u{1D459}" +
    "\u{1D470}\u{1D48D}\u{1D4C1}\u{1D4D8}\u{1D4F5}\u{1D529}\u{1D540}\u{1D55D}\u{1D574}\u{1D591}\u{1D5A8}\u{1D5C5}" +
    "\u{1D5DC}\u{1D5F9}\u{1D610}\u{1D62D}\u{1D644}\u{1D661}\u{1D678}\u{1D695}\u{1D6B0}\u{1D6EA}\u{1D724}\u{1D75E}" +
    "\u{1D798}\u{1D7CF}\u{1D7D9}\u{1D7E3}\u{1D7ED}\u{1D7F7}\u{1E8C7}\u{1EE00}\u{1EE80}\u{1FBF1}",
  "2": "\u{B2}\u{1A7}\u{3E8}\u{14BF}\u{2082}\u{2461}\u{A644}\u{A6EF}\u{A75A}\u{FF12}\u{1CCF2}\u{1D7D0}" +
    "\u{1D7DA}\u{1D7E4}\u{1D7EE}\u{1D7F8}\u{1FBF2}",
  "3": "\u{B3}\u{1B7}\u{21C}\u{417}\u{4E0}\u{969}\u{AE9}\u{2083}\u{2462}\u{2C9C}\u{2CC4}\u{2CCC}" +
    "\u{A76A}\u{A7AB}\u{FF13}\u{118CA}\u{16F3B}\u{1CCF3}\u{1D206}\u{1D7D1}\u{1D7DB}\u{1D7E5}\u{1D7EF}\u{1D7F9}" +
    "\u{1FBF3}",
  "4": "\u{13CE}\u{2074}\u{2084}\u{2463}\u{FF14}\u{118AF}\u{1CCF4}\u{1D7D2}\u{1D7DC}\u{1D7E6}\u{1D7F0}\u{1D7FA}" +
    "\u{1FBF4}",
  "5": "\u{1BC}\u{2075}\u{2085}\u{2464}\u{FF15}\u{118BB}\u{1CCF5}\u{1D7D3}\u{1D7DD}\u{1D7E7}\u{1D7F1}\u{1D7FB}" +
    "\u{1FBF5}",
  "6": "\u{3EC}\u{431}\u{13EE}\u{2076}\u{2086}\u{2465}\u{2CD2}\u{2CD3}\u{2CDC}\u{FF16}\u{118D5}\u{1CCF6}" +
    "\u{1D7D4}\u{1D7DE}\u{1D7E8}\u{1D7F2}\u{1D7FC}\u{1FBF6}",
  "7": "\u{2077}\u{2087}\u{2466}\u{FF17}\u{104D2}\u{118C6}\u{1CCF7}\u{1D212}\u{1D7D5}\u{1D7DF}\u{1D7E9}\u{1D7F3}" +
    "\u{1D7FD}\u{1FBF7}",
  "8": "\u{222}\u{223}\u{9EA}\u{A6A}\u{B03}\u{2078}\u{2088}\u{2467}\u{FF18}\u{1031A}\u{1CCF8}\u{1D7D6}" +
    "\u{1D7E0}\u{1D7EA}\u{1D7F4}\u{1D7FE}\u{1E8CB}\u{1FBF8}",
  "9": "\u{9ED}\u{A67}\u{B68}\u{D6D}\u{2079}\u{2089}\u{2468}\u{2CCA}\u{2CCB}\u{A76E}\u{FF19}\u{118AC}" +
    "\u{118CC}\u{118D6}\u{1CCF9}\u{1D7D7}\u{1D7E1}\u{1D7EB}\u{1D7F5}\u{1D7FF}\u{1FBF9}",
  "a": "\u{AA}\u{251}\u{391}\u{3B1}\u{410}\u{430}\u{13AA}\u{15C5}\u{1D2C}\u{1D43}\u{2090}\u{237A}" +
    "\u{24B6}\u{24D0}\u{A4EE}\u{FF21}\u{FF41}\u{102A0}\u{16F40}\u{1CCD6}\u{1D400}\u{1D41A}\u{1D434}\u{1D44E}" +
    "\u{1D468}\u{1D482}\u{1D49C}\u{1D4B6}\u{1D4D0}\u{1D4EA}\u{1D504}\u{1D51E}\u{1D538}\u{1D552}\u{1D56C}\u{1D586}" +
    "\u{1D5A0}\u{1D5BA}\u{1D5D4}\u{1D5EE}\u{1D608}\u{1D622}\u{1D63C}\u{1D656}\u{1D670}\u{1D68A}\u{1D6A8}\u{1D6C2}" +
    "\u{1D6E2}\u{1D6FC}\u{1D71C}\u{1D736}\u{1D756}\u{1D770}\u{1D790}\u{1D7AA}\u{1F130}",
  "b": "\u{184}\u{392}\u{412}\u{42C}\u{432}\u{44C}\u{13CF}\u{13F4}\u{1472}\u{15AF}\u{15F7}\u{1D2E}" +
    "\u{1D47}\u{212C}\u{24B7}\u{24D1}\u{2C82}\u{A4D0}\u{A7B4}\u{FF22}\u{FF42}\u{10282}\u{102A1}\u{10301}" +
    "\u{16EB6}\u{1CCD7}\u{1D401}\u{1D41B}\u{1D435}\u{1D44F}\u{1D469}\u{1D483}\u{1D4B7}\u{1D4D1}\u{1D4EB}\u{1D505}" +
    "\u{1D51F}\u{1D539}\u{1D553}\u{1D56D}\u{1D587}\u{1D5A1}\u{1D5BB}\u{1D5D5}\u{1D5EF}\u{1D609}\u{1D623}\u{1D63D}" +
    "\u{1D657}\u{1D671}\u{1D68B}\u{1D6A9}\u{1D6E3}\u{1D71D}\u{1D757}\u{1D791}\u{1F131}",
  "c": "\u{3F2}\u{3F9}\u{421}\u{441}\u{1004}\u{105A}\u{13DF}\u{1D04}\u{1D9C}\u{2102}\u{212D}\u{216D}" +
    "\u{217D}\u{24B8}\u{24D2}\u{2CA4}\u{2CA5}\u{A4DA}\u{A7F2}\u{ABAF}\u{FF23}\u{FF43}\u{102A2}\u{10302}" +
    "\u{10415}\u{1043D}\u{1051C}\u{118E9}\u{118F2}\u{1CCD8}\u{1D402}\u{1D41C}\u{1D436}\u{1D450}\u{1D46A}\u{1D484}" +
    "\u{1D49E}\u{1D4B8}\u{1D4D2}\u{1D4EC}\u{1D520}\u{1D554}\u{1D56E}\u{1D588}\u{1D5A2}\u{1D5BC}\u{1D5D6}\u{1D5F0}" +
    "\u{1D60A}\u{1D624}\u{1D63E}\u{1D658}\u{1D672}\u{1D68C}\u{1F12B}\u{1F132}\u{1F74C}",
  "d": "\u{501}\u{13A0}\u{13E7}\u{146F}\u{15DE}\u{15EA}\u{1D05}\u{1D30}\u{1D48}\u{2145}\u{2146}\u{216E}" +
    "\u{217E}\u{24B9}\u{24D3}\u{A4D2}\u{A4D3}\u{FF24}\u{FF44}\u{1CCD9}\u{1D403}\u{1D41D}\u{1D437}\u{1D451}" +
    "\u{1D46B}\u{1D485}\u{1D49F}\u{1D4B9}\u{1D4D3}\u{1D4ED}\u{1D507}\u{1D521}\u{1D53B}\u{1D555}\u{1D56F}\u{1D589}" +
    "\u{1D5A3}\u{1D5BD}\u{1D5D7}\u{1D5F1}\u{1D60B}\u{1D625}\u{1D63F}\u{1D659}\u{1D673}\u{1D68D}\u{1F133}",
  "e": "\u{395}\u{415}\u{435}\u{4BD}\u{13AC}\u{1D31}\u{1D49}\u{2091}\u{212E}\u{212F}\u{2130}\u{2147}" +
    "\u{22FF}\u{24BA}\u{24D4}\u{2D39}\u{A4F0}\u{AB32}\u{FF25}\u{FF45}\u{10286}\u{118A6}\u{118AE}\u{1CCDA}" +
    "\u{1D404}\u{1D41E}\u{1D438}\u{1D452}\u{1D46C}\u{1D486}\u{1D4D4}\u{1D4EE}\u{1D508}\u{1D522}\u{1D53C}\u{1D556}" +
    "\u{1D570}\u{1D58A}\u{1D5A4}\u{1D5BE}\u{1D5D8}\u{1D5F2}\u{1D60C}\u{1D626}\u{1D640}\u{1D65A}\u{1D674}\u{1D68E}" +
    "\u{1D6AC}\u{1D6E6}\u{1D720}\u{1D75A}\u{1D794}\u{1F134}",
  "f": "\u{17F}\u{192}\u{3DC}\u{584}\u{15B4}\u{1DA0}\u{1E9D}\u{2131}\u{24BB}\u{24D5}\u{A4DD}\u{A798}" +
    "\u{A799}\u{A7F3}\u{AB35}\u{FF26}\u{FF46}\u{10287}\u{102A5}\u{10525}\u{118A2}\u{118C2}\u{1CCDB}\u{1D213}" +
    "\u{1D405}\u{1D41F}\u{1D439}\u{1D453}\u{1D46D}\u{1D487}\u{1D4BB}\u{1D4D5}\u{1D4EF}\u{1D509}\u{1D523}\u{1D53D}" +
    "\u{1D557}\u{1D571}\u{1D58B}\u{1D5A5}\u{1D5BF}\u{1D5D9}\u{1D5F3}\u{1D60D}\u{1D627}\u{1D641}\u{1D65B}\u{1D675}" +
    "\u{1D68F}\u{1D7CA}\u{1F135}",
  "g": "\u{18D}\u{261}\u{50C}\u{581}\u{13C0}\u{13F3}\u{1D33}\u{1D4D}\u{1D83}\u{210A}\u{24BC}\u{24D6}" +
    "\u{A4D6}\u{FF27}\u{FF47}\u{1CCDC}\u{1D406}\u{1D420}\u{1D43A}\u{1D454}\u{1D46E}\u{1D488}\u{1D4A2}\u{1D4D6}" +
    "\u{1D4F0}\u{1D50A}\u{1D524}\u{1D53E}\u{1D558}\u{1D572}\u{1D58C}\u{1D5A6}\u{1D5C0}\u{1D5DA}\u{1D5F4}\u{1D60E}" +
    "\u{1D628}\u{1D642}\u{1D65C}\u{1D676}\u{1D690}\u{1F136}",
  "h": "\u{2B0}\u{397}\u{41D}\u{43D}\u{4BB}\u{570}\u{13BB}\u{13C2}\u{157C}\u{1D34}\u{2095}\u{210B}" +
    "\u{210C}\u{210D}\u{210E}\u{24BD}\u{24D7}\u{2C8E}\u{A4E7}\u{FF28}\u{FF48}\u{102CF}\u{1CCDD}\u{1D407}" +
    "\u{1D421}\u{1D43B}\u{1D46F}\u{1D489}\u{1D4BD}\u{1D4D7}\u{1D4F1}\u{1D525}\u{1D559}\u{1D573}\u{1D58D}\u{1D5A7}" +
    "\u{1D5C1}\u{1D5DB}\u{1D5F5}\u{1D60F}\u{1D629}\u{1D643}\u{1D65D}\u{1D677}\u{1D691}\u{1D6AE}\u{1D6E8}\u{1D722}" +
    "\u{1D75C}\u{1D796}\u{1F137}",
  "i": "\u{31}\u{7C}\u{131}\u{196}\u{1C0}\u{269}\u{26A}\u{2DB}\u{37A}\u{399}\u{3B9}\u{406}" +
    "\u{456}\u{4C0}\u{4CF}\u{582}\u{5C0}\u{5D5}\u{5DF}\u{627}\u{661}\u{6F1}\u{7CA}\u{13A5}" +
    "\u{16C1}\u{1D35}\u{1D62}\u{1FBE}\u{2071}\u{2110}\u{2111}\u{2113}\u{2139}\u{2148}\u{2160}\u{2170}" +
    "\u{217C}\u{2223}\u{2373}\u{23FD}\u{24BE}\u{24D8}\u{2C92}\u{2C93}\u{2D4F}\u{A4F2}\u{A647}\u{AB75}" +
    "\u{FE8D}\u{FE8E}\u{FF29}\u{FF49}\u{FF4C}\u{FFE8}\u{1028A}\u{10309}\u{10320}\u{118C3}\u{11DDA}\u{11DE1}" +
    "\u{16EAA}\u{16F28}\u{1CCDE}\u{1CCF1}\u{1D408}\u{1D422}\u{1D425}\u{1D43C}\u{1D456}\u{1D459}\u{1D470}\u{1D48A}" +
    "\u{1D48D}\u{1D4BE}\u{1D4C1}\u{1D4D8}\u{1D4F2}\u{1D4F5}\u{1D526}\u{1D529}\u{1D540}\u{1D55A}\u{1D55D}\u{1D574}" +
    "\u{1D58E}\u{1D591}\u{1D5A8}\u{1D5C2}\u{1D5C5}\u{1D5DC}\u{1D5F6}\u{1D5F9}\u{1D610}\u{1D62A}\u{1D62D}\u{1D644}" +
    "\u{1D65E}\u{1D661}\u{1D678}\u{1D692}\u{1D695}\u{1D6A4}\u{1D6B0}\u{1D6CA}\u{1D6EA}\u{1D704}\u{1D724}\u{1D73E}" +
    "\u{1D75E}\u{1D778}\u{1D798}\u{1D7B2}\u{1D7CF}\u{1D7D9}\u{1D7E3}\u{1D7ED}\u{1D7F7}\u{1E8C7}\u{1EE00}\u{1EE80}" +
    "\u{1F138}\u{1FBF1}",
  "j": "\u{2B2}\u{37F}\u{3F3}\u{408}\u{458}\u{13AB}\u{148D}\u{1D36}\u{2149}\u{24BF}\u{24D9}\u{2C7C}" +
    "\u{A4D9}\u{A7B2}\u{FF2A}\u{FF4A}\u{1CCDF}\u{1D409}\u{1D423}\u{1D43D}\u{1D457}\u{1D471}\u{1D48B}\u{1D4A5}" +
    "\u{1D4BF}\u{1D4D9}\u{1D4F3}\u{1D50D}\u{1D527}\u{1D541}\u{1D55B}\u{1D575}\u{1D58F}\u{1D5A9}\u{1D5C3}\u{1D5DD}" +
    "\u{1D5F7}\u{1D611}\u{1D62B}\u{1D645}\u{1D65F}\u{1D679}\u{1D693}\u{1F139}",
  "k": "\u{39A}\u{41A}\u{43A}\u{13E6}\u{16D5}\u{1D37}\u{1D4F}\u{2096}\u{212A}\u{24C0}\u{24DA}\u{2C94}" +
    "\u{A4D7}\u{FF2B}\u{FF4B}\u{10518}\u{1CCE0}\u{1D40A}\u{1D424}\u{1D43E}\u{1D458}\u{1D472}\u{1D48C}\u{1D4A6}" +
    "\u{1D4C0}\u{1D4DA}\u{1D4F4}\u{1D50E}\u{1D528}\u{1D542}\u{1D55C}\u{1D576}\u{1D590}\u{1D5AA}\u{1D5C4}\u{1D5DE}" +
    "\u{1D5F8}\u{1D612}\u{1D62C}\u{1D646}\u{1D660}\u{1D67A}\u{1D694}\u{1D6B1}\u{1D6EB}\u{1D725}\u{1D75F}\u{1D799}" +
    "\u{1F13A}",
  "l": "\u{31}\u{49}\u{7C}\u{196}\u{1C0}\u{2E1}\u{399}\u{406}\u{4C0}\u{4CF}\u{5C0}\u{5D5}" +
    "\u{5DF}\u{627}\u{661}\u{6F1}\u{7CA}\u{13DE}\u{14AA}\u{16C1}\u{1D38}\u{2097}\u{2110}\u{2111}" +
    "\u{2112}\u{2113}\u{2160}\u{216C}\u{217C}\u{2223}\u{23FD}\u{24C1}\u{24DB}\u{2C92}\u{2CD0}\u{2D4F}" +
    "\u{A4E1}\u{A4F2}\u{FE8D}\u{FE8E}\u{FF29}\u{FF2C}\u{FF4C}\u{FFE8}\u{1028A}\u{10309}\u{10320}\u{1041B}" +
    "\u{10526}\u{118A3}\u{118B2}\u{11DDA}\u{11DE1}\u{16EAA}\u{16F16}\u{16F28}\u{1CCDE}\u{1CCE1}\u{1CCF1}\u{1D22A}" +
    "\u{1D408}\u{1D40B}\u{1D425}\u{1D43C}\u{1D43F}\u{1D459}\u{1D470}\u{1D473}\u{1D48D}\u{1D4C1}\u{1D4D8}\u{1D4DB}" +
    "\u{1D4F5}\u{1D50F}\u{1D529}\u{1D540}\u{1D543}\u{1D55D}\u{1D574}\u{1D577}\u{1D591}\u{1D5A8}\u{1D5AB}\u{1D5C5}" +
    "\u{1D5DC}\u{1D5DF}\u{1D5F9}\u{1D610}\u{1D613}\u{1D62D}\u{1D644}\u{1D647}\u{1D661}\u{1D678}\u{1D67B}\u{1D695}" +
    "\u{1D6B0}\u{1D6EA}\u{1D724}\u{1D75E}\u{1D798}\u{1D7CF}\u{1D7D9}\u{1D7E3}\u{1D7ED}\u{1D7F7}\u{1E8C7}\u{1EE00}" +
    "\u{1EE80}\u{1F13B}\u{1FBF1}",
  "m": "\u{39C}\u{3FA}\u{41C}\u{43C}\u{13B7}\u{15F0}\u{16D6}\u{1D39}\u{1D50}\u{2098}\u{2133}\u{216F}" +
    "\u{217F}\u{24C2}\u{24DC}\u{2C98}\u{A4DF}\u{FF2D}\u{FF4D}\u{102B0}\u{10311}\u{11700}\u{118E3}\u{1CCE2}" +
    "\u{1D40C}\u{1D426}\u{1D440}\u{1D45A}\u{1D474}\u{1D48E}\u{1D4C2}\u{1D4DC}\u{1D4F6}\u{1D510}\u{1D52A}\u{1D544}" +
    "\u{1D55E}\u{1D578}\u{1D592}\u{1D5AC}\u{1D5C6}\u{1D5E0}\u{1D5FA}\u{1D614}\u{1D62E}\u{1D648}\u{1D662}\u{1D67C}" +
    "\u{1D696}\u{1D6B3}\u{1D6ED}\u{1D727}\u{1D761}\u{1D79B}\u{1F13C}",
  "n": "\u{39D}\u{3B7}\u{43F}\u{578}\u{57C}\u{1D3A}\u{207F}\u{2099}\u{2115}\u{24C3}\u{24DD}\u{2C9A}" +
    "\u{A4E0}\u{FF2E}\u{FF4E}\u{10513}\u{1CCE3}\u{1D40D}\u{1D427}\u{1D441}\u{1D45B}\u{1D475}\u{1D48F}\u{1D4A9}" +
    "\u{1D4C3}\u{1D4DD}\u{1D4F7}\u{1D511}\u{1D52B}\u{1D55F}\u{1D579}\u{1D593}\u{1D5AD}\u{1D5C7}\u{1D5E1}\u{1D5FB}" +
    "\u{1D615}\u{1D62F}\u{1D649}\u{1D663}\u{1D67D}\u{1D697}\u{1D6B4}\u{1D6EE}\u{1D728}\u{1D762}\u{1D79C}\u{1F13D}",
  "o": "\u{30}\u{BA}\u{39F}\u{3BF}\u{3C3}\u{3ED}\u{41E}\u{43E}\u{555}\u{585}\u{5E1}\u{647}" +
    "\u{665}\u{6BE}\u{6C1}\u{6D5}\u{6F5}\u{7C0}\u{966}\u{9E6}\u{A66}\u{AE6}\u{B20}\u{B66}" +
    "\u{BE6}\u{C02}\u{C66}\u{C82}\u{CE6}\u{D02}\u{D20}\u{D66}\u{D82}\u{E50}\u{ED0}\u{101D}" +
    "\u{1040}\u{10FF}\u{12D0}\u{17E0}\u{1D0F}\u{1D11}\u{1D3C}\u{1D52}\u{2092}\u{2134}\u{24C4}\u{24DE}" +
    "\u{2C9E}\u{2C9F}\u{2D54}\u{3007}\u{A4F3}\u{AB3D}\u{FBA6}\u{FBA7}\u{FBA8}\u{FBA9}\u{FBAA}\u{FBAB}" +
    "\u{FBAC}\u{FBAD}\u{FEE9}\u{FEEA}\u{FEEB}\u{FEEC}\u{FF2F}\u{FF4F}\u{10292}\u{102AB}\u{10404}\u{1042C}" +
    "\u{104C2}\u{104EA}\u{10516}\u{114D0}\u{118B5}\u{118C8}\u{118D7}\u{118E0}\u{11DE0}\u{1CCE4}\u{1CCF0}\u{1D40E}" +
    "\u{1D428}\u{1D442}\u{1D45C}\u{1D476}\u{1D490}\u{1D4AA}\u{1D4DE}\u{1D4F8}\u{1D512}\u{1D52C}\u{1D546}\u{1D560}" +
    "\u{1D57A}\u{1D594}\u{1D5AE}\u{1D5C8}\u{1D5E2}\u{1D5FC}\u{1D616}\u{1D630}\u{1D64A}\u{1D664}\u{1D67E}\u{1D698}" +
    "\u{1D6B6}\u{1D6D0}\u{1D6D4}\u{1D6F0}\u{1D70A}\u{1D70E}\u{1D72A}\u{1D744}\u{1D748}\u{1D764}\u{1D77E}\u{1D782}" +
    "\u{1D79E}\u{1D7B8}\u{1D7BC}\u{1D7CE}\u{1D7D8}\u{1D7E2}\u{1D7EC}\u{1D7F6}\u{1EE24}\u{1EE64}\u{1EE84}\u{1F13E}" +
    "\u{1FBF0}",
  "p": "\u{FE}\u{1BF}\u{3A1}\u{3C1}\u{3F1}\u{3F8}\u{420}\u{440}\u{13E2}\u{146D}\u{1D3E}\u{1D56}" +
    "\u{209A}\u{2119}\u{2374}\u{24C5}\u{24DF}\u{2CA2}\u{2CA3}\u{2CCE}\u{2CCF}\u{A4D1}\u{FF30}\u{FF50}" +
    "\u{10295}\u{1CCE5}\u{1D40F}\u{1D429}\u{1D443}\u{1D45D}\u{1D477}\u{1D491}\u{1D4AB}\u{1D4C5}\u{1D4DF}\u{1D4F9}" +
    "\u{1D513}\u{1D52D}\u{1D561}\u{1D57B}\u{1D595}\u{1D5AF}\u{1D5C9}\u{1D5E3}\u{1D5FD}\u{1D617}\u{1D631}\u{1D64B}" +
    "\u{1D665}\u{1D67F}\u{1D699}\u{1D6B8}\u{1D6D2}\u{1D6E0}\u{1D6F2}\u{1D70C}\u{1D71A}\u{1D72C}\u{1D746}\u{1D754}" +
    "\u{1D766}\u{1D780}\u{1D78E}\u{1D7A0}\u{1D7BA}\u{1D7C8}\u{1F13F}",
  "q": "\u{51B}\u{563}\u{566}\u{211A}\u{24C6}\u{24E0}\u{2D55}\u{A7F4}\u{FF31}\u{FF51}\u{107A5}\u{1CCE6}" +
    "\u{1D410}\u{1D42A}\u{1D444}\u{1D45E}\u{1D478}\u{1D492}\u{1D4AC}\u{1D4C6}\u{1D4E0}\u{1D4FA}\u{1D514}\u{1D52E}" +
    "\u{1D562}\u{1D57C}\u{1D596}\u{1D5B0}\u{1D5CA}\u{1D5E4}\u{1D5FE}\u{1D618}\u{1D632}\u{1D64C}\u{1D666}\u{1D680}" +
    "\u{1D69A}\u{1F140}",
  "r": "\u{1A6}\u{2B3}\u{433}\u{13A1}\u{13D2}\u{1587}\u{1D26}\u{1D3F}\u{1D63}\u{211B}\u{211C}\u{211D}" +
    "\u{24C7}\u{24E1}\u{2C85}\u{A4E3}\u{AB47}\u{AB48}\u{AB81}\u{FF32}\u{FF52}\u{104B4}\u{16F35}\u{1CCE7}" +
    "\u{1D216}\u{1D411}\u{1D42B}\u{1D445}\u{1D45F}\u{1D479}\u{1D493}\u{1D4C7}\u{1D4E1}\u{1D4FB}\u{1D52F}\u{1D563}" +
    "\u{1D57D}\u{1D597}\u{1D5B1}\u{1D5CB}\u{1D5E5}\u{1D5FF}\u{1D619}\u{1D633}\u{1D64D}\u{1D667}\u{1D681}\u{1D69B}" +
    "\u{1F12C}\u{1F141}",
  "s": "\u{17F}\u{1BD}\u{2E2}\u{405}\u{455}\u{54F}\u{D1F}\u{13D5}\u{13DA}\u{209B}\u{24C8}\u{24E2}" +
    "\u{A4E2}\u{A731}\u{A7F1}\u{ABAA}\u{FF33}\u{FF53}\u{10296}\u{10420}\u{10448}\u{118C1}\u{16F3A}\u{1CCE8}" +
    "\u{1D412}\u{1D42C}\u{1D446}\u{1D460}\u{1D47A}\u{1D494}\u{1D4AE}\u{1D4C8}\u{1D4E2}\u{1D4FC}\u{1D516}\u{1D530}" +
    "\u{1D54A}\u{1D564}\u{1D57E}\u{1D598}\u{1D5B2}\u{1D5CC}\u{1D5E6}\u{1D600}\u{1D61A}\u{1D634}\u{1D64E}\u{1D668}" +
    "\u{1D682}\u{1D69C}\u{1F142}",
  "t": "\u{3A4}\u{422}\u{442}\u{13A2}\u{1D40}\u{1D57}\u{209C}\u{22A4}\u{24C9}\u{24E3}\u{27D9}\u{2CA6}" +
    "\u{A4D4}\u{FF34}\u{FF54}\u{10297}\u{102B1}\u{10315}\u{118BC}\u{16F0A}\u{1CCE9}\u{1D413}\u{1D42D}\u{1D447}" +
    "\u{1D461}\u{1D47B}\u{1D495}\u{1D4AF}\u{1D4C9}\u{1D4E3}\u{1D4FD}\u{1D517}\u{1D531}\u{1D54B}\u{1D565}\u{1D57F}" +
    "\u{1D599}\u{1D5B3}\u{1D5CD}\u{1D5E7}\u{1D601}\u{1D61B}\u{1D635}\u{1D64F}\u{1D669}\u{1D683}\u{1D69D}\u{1D6BB}" +
    "\u{1D6F5}\u{1D72F}\u{1D769}\u{1D7A3}\u{1F143}\u{1F768}",
  "u": "\u{28B}\u{3C5}\u{54D}\u{57D}\u{1200}\u{144C}\u{1D1C}\u{1D41}\u{1D58}\u{1D64}\u{222A}\u{22C3}" +
    "\u{24CA}\u{24E4}\u{A4F4}\u{A79F}\u{AB4E}\u{AB52}\u{FF35}\u{FF55}\u{104CE}\u{104F6}\u{118B8}\u{118D8}" +
    "\u{16F42}\u{1CCEA}\u{1D414}\u{1D42E}\u{1D448}\u{1D462}\u{1D47C}\u{1D496}\u{1D4B0}\u{1D4CA}\u{1D4E4}\u{1D4FE}" +
    "\u{1D518}\u{1D532}\u{1D54C}\u{1D566}\u{1D580}\u{1D59A}\u{1D5B4}\u{1D5CE}\u{1D5E8}\u{1D602}\u{1D61C}\u{1D636}" +
    "\u{1D650}\u{1D66A}\u{1D684}\u{1D69E}\u{1D6D6}\u{1D710}\u{1D74A}\u{1D784}\u{1D7BE}\u{1F144}",
  "v": "\u{3BD}\u{474}\u{475}\u{5D8}\u{667}\u{6F7}\u{13D9}\u{142F}\u{1D20}\u{1D5B}\u{1D65}\u{2164}" +
    "\u{2174}\u{2228}\u{22C1}\u{24CB}\u{24E5}\u{2C7D}\u{2D38}\u{A4E6}\u{A6DF}\u{ABA9}\u{FF36}\u{FF56}" +
    "\u{1051D}\u{11706}\u{118A0}\u{118C0}\u{16F08}\u{1CCEB}\u{1D20D}\u{1D415}\u{1D42F}\u{1D449}\u{1D463}\u{1D47D}" +
    "\u{1D497}\u{1D4B1}\u{1D4CB}\u{1D4E5}\u{1D4FF}\u{1D519}\u{1D533}\u{1D54D}\u{1D567}\u{1D581}\u{1D59B}\u{1D5B5}" +
    "\u{1D5CF}\u{1D5E9}\u{1D603}\u{1D61D}\u{1D637}\u{1D651}\u{1D66B}\u{1D685}\u{1D69F}\u{1D6CE}\u{1D708}\u{1D742}" +
    "\u{1D77C}\u{1D7B6}\u{1F145}",
  "w": "\u{26F}\u{2B7}\u{448}\u{461}\u{51C}\u{51D}\u{561}\u{13B3}\u{13D4}\u{1D21}\u{1D42}\u{24CC}" +
    "\u{24E6}\u{2CBD}\u{A4EA}\u{AB83}\u{FF37}\u{FF57}\u{1170A}\u{1170E}\u{1170F}\u{118E6}\u{118EF}\u{1CCEC}" +
    "\u{1D416}\u{1D430}\u{1D44A}\u{1D464}\u{1D47E}\u{1D498}\u{1D4B2}\u{1D4CC}\u{1D4E6}\u{1D500}\u{1D51A}\u{1D534}" +
    "\u{1D54E}\u{1D568}\u{1D582}\u{1D59C}\u{1D5B6}\u{1D5D0}\u{1D5EA}\u{1D604}\u{1D61E}\u{1D638}\u{1D652}\u{1D66C}" +
    "\u{1D686}\u{1D6A0}\u{1F146}",
  "x": "\u{D7}\u{2E3}\u{3A7}\u{425}\u{445}\u{1541}\u{157D}\u{166D}\u{166E}\u{16B7}\u{2093}\u{2169}" +
    "\u{2179}\u{24CD}\u{24E7}\u{2573}\u{292B}\u{292C}\u{2A2F}\u{2CAC}\u{2D5D}\u{A4EB}\u{A7B3}\u{FF38}" +
    "\u{FF58}\u{10290}\u{102B4}\u{10317}\u{10322}\u{10527}\u{118EC}\u{1CCED}\u{1D417}\u{1D431}\u{1D44B}\u{1D465}" +
    "\u{1D47F}\u{1D499}\u{1D4B3}\u{1D4CD}\u{1D4E7}\u{1D501}\u{1D51B}\u{1D535}\u{1D54F}\u{1D569}\u{1D583}\u{1D59D}" +
    "\u{1D5B7}\u{1D5D1}\u{1D5EB}\u{1D605}\u{1D61F}\u{1D639}\u{1D653}\u{1D66D}\u{1D687}\u{1D6A1}\u{1D6BE}\u{1D6F8}" +
    "\u{1D732}\u{1D76C}\u{1D7A6}\u{1F147}",
  "y": "\u{263}\u{28F}\u{2B8}\u{3A5}\u{3B3}\u{3D2}\u{423}\u{443}\u{4AE}\u{4AF}\u{10E7}\u{13A9}" +
    "\u{13BD}\u{1D8C}\u{1EFF}\u{213D}\u{24CE}\u{24E8}\u{2CA8}\u{2CA9}\u{A4EC}\u{AB5A}\u{FF39}\u{FF59}" +
    "\u{102B2}\u{118A4}\u{118DC}\u{16F43}\u{1CCEE}\u{1D418}\u{1D432}\u{1D44C}\u{1D466}\u{1D480}\u{1D49A}\u{1D4B4}" +
    "\u{1D4CE}\u{1D4E8}\u{1D502}\u{1D51C}\u{1D536}\u{1D550}\u{1D56A}\u{1D584}\u{1D59E}\u{1D5B8}\u{1D5D2}\u{1D5EC}" +
    "\u{1D606}\u{1D620}\u{1D63A}\u{1D654}\u{1D66E}\u{1D688}\u{1D6A2}\u{1D6BC}\u{1D6C4}\u{1D6F6}\u{1D6FE}\u{1D730}" +
    "\u{1D738}\u{1D76A}\u{1D772}\u{1D7A4}\u{1D7AC}\u{1F148}",
  "z": "\u{396}\u{13C3}\u{1D22}\u{1DBB}\u{2124}\u{2128}\u{24CF}\u{24E9}\u{A4DC}\u{AB93}\u{FF3A}\u{FF5A}" +
    "\u{102F5}\u{118A9}\u{118C4}\u{118E5}\u{1CCEF}\u{1D419}\u{1D433}\u{1D44D}\u{1D467}\u{1D481}\u{1D49B}\u{1D4B5}" +
    "\u{1D4CF}\u{1D4E9}\u{1D503}\u{1D537}\u{1D56B}\u{1D585}\u{1D59F}\u{1D5B9}\u{1D5D3}\u{1D5ED}\u{1D607}\u{1D621}" +
    "\u{1D63B}\u{1D655}\u{1D66F}\u{1D689}\u{1D6A3}\u{1D6AD}\u{1D6E7}\u{1D721}\u{1D75B}\u{1D795}\u{1F149}",
  ".": "\u{660}\u{6F0}\u{701}\u{702}\u{2024}\u{A4F8}\u{A60E}\u{FE52}\u{FF0E}\u{10A50}\u{1D16D}",
  "_": "\u{7FA}\u{FE33}\u{FE34}\u{FE4D}\u{FE4E}\u{FE4F}\u{FF3F}",
  ":": "\u{2D0}\u{2F8}\u{589}\u{5C3}\u{703}\u{704}\u{903}\u{A83}\u{16EC}\u{1803}\u{1809}\u{205A}" +
    "\u{2236}\u{A4FD}\u{A789}\u{FE13}\u{FE30}\u{FE55}\u{FF1A}\u{11DD9}",
  "-": "\u{2D7}\u{6D4}\u{2010}\u{2011}\u{2012}\u{2013}\u{2043}\u{2212}\u{2796}\u{2CBA}\u{2CBB}\u{FE58}" +
    "\u{FE63}\u{FF0D}",
} satisfies Readonly<Record<string, string>>);
// Mechanically generated one-code-point NFKC preimages of the base classes
// above. Keeping the closure explicit makes matching independent of ambient
// Unicode normalization-version drift; the exhaustive test audits all entries.
const PROTECTED_NFKC_COMPATIBILITY_EQUIVALENTS = Object.freeze({
  "-": "\u{207B}\u{208B}\u{FE32}",
  "1": "\u{1D35}\u{24BE}\u{FF5C}\u{107B6}\u{1E050}\u{1F138}",
  "6": "\u{1E031}\u{1E052}",
  "8": "\u{1D3D}",
  ":": "\u{10781}",
  "a": "\u{1D45}\u{1E030}\u{1E051}",
  "b": "\u{A69D}\u{1E032}\u{1E053}",
  "c": "\u{1E03F}\u{1E05E}",
  "e": "\u{1E035}\u{1E056}",
  "g": "\u{1DA2}",
  "h": "\u{1D78}",
  "i": "\u{B9}\u{1DA5}\u{1DA6}\u{2081}\u{2460}\u{FF11}\u{FF5C}\u{107B6}\u{1E04C}\u{1E050}\u{1E068}",
  "j": "\u{1E04D}",
  "k": "\u{1E039}\u{1E05A}",
  "l": "\u{B9}\u{1D35}\u{2081}\u{2460}\u{24BE}\u{FF11}\u{FF5C}\u{107B6}\u{1E050}\u{1F138}",
  "m": "\u{1E03B}",
  "n": "\u{1D6C8}\u{1D702}\u{1D73C}\u{1D776}\u{1D7B0}\u{1E03D}\u{1E05D}",
  "o": "\u{2070}\u{2080}\u{24EA}\u{FF10}\u{1E03C}\u{1E05C}",
  "p": "\u{1D68}\u{1E03E}",
  "r": "\u{1E033}\u{1E054}",
  "s": "\u{1E069}",
  "t": "\u{1E040}",
  "u": "\u{1DB8}\u{1DB9}\u{AB5F}",
  "w": "\u{1D5A}\u{1E046}\u{1E064}",
  "x": "\u{1E043}\u{1E061}",
  "y": "\u{2E0}\u{1D5E}\u{1D67}\u{107B2}\u{1E041}\u{1E04F}\u{1E05F}",
} satisfies Readonly<Record<string, string>>);
const LONG_HEX_SECRET_PATTERN = /\b[0-9a-f]{40,}\b/iu;
const LONG_BASE64_SECRET_PATTERN = /\b[A-Za-z0-9+/]{48,}={0,2}\b/u;
const SECRET_PATTERNS = Object.freeze([
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/u,
  /\bAKIA[A-Z0-9]{16}\b/u,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/u,
  /\bAIza[0-9A-Za-z_-]{30,}/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*/iu,
  LONG_HEX_SECRET_PATTERN,
  LONG_BASE64_SECRET_PATTERN,
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"]?[^\s'"]{8,}/iu,
] as const);

export function containsAbsoluteLocalPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (LOCAL_PATH_PATTERNS.some((pattern) => pattern.test(value))) return true;
  for (const match of value.matchAll(FORWARD_UNC_PATTERN)) {
    const prefix = value.slice(0, match.index);
    const scheme = /([A-Za-z][A-Za-z0-9+.-]*):$/u.exec(prefix)?.[1]?.toLowerCase();
    if (scheme === undefined || scheme === "file" || scheme === "path") return true;
  }
  return false;
}

export function containsIntakeSecretShape(
  value: unknown,
  options: Readonly<{ allowDigest?: boolean }> = {},
): boolean {
  return typeof value === "string" && SECRET_PATTERNS.some((pattern) =>
    !(options.allowDigest === true
      && (pattern === LONG_HEX_SECRET_PATTERN || pattern === LONG_BASE64_SECRET_PATTERN))
    && pattern.test(value));
}

type ProtectedAscii = keyof typeof PROTECTED_CONFUSABLE_EQUIVALENTS;

const PROTECTED_ALPHANUMERIC_CLASSES = "abcdefghijklmnopqrstuvwxyz0123456789";
const PROTECTED_HEX_CLASSES = "abcdef0123456789";
const UNICODE_IDENTIFIER_UNIT_PATTERN = /^[\p{L}\p{N}\p{M}]$/u;

export function protectedBaseConfusableEquivalent(actual: string, expected: string): boolean {
  if (!Object.hasOwn(PROTECTED_CONFUSABLE_EQUIVALENTS, expected)) return false;
  if (actual.toLocaleLowerCase("en-GB") === expected) return true;
  const equivalents = PROTECTED_CONFUSABLE_EQUIVALENTS[expected as ProtectedAscii];
  return equivalents !== undefined && equivalents.includes(actual);
}

export function protectedDirectConfusableEquivalent(actual: string, expected: string): boolean {
  if (protectedBaseConfusableEquivalent(actual, expected)) return true;
  const compatible = (PROTECTED_NFKC_COMPATIBILITY_EQUIVALENTS as Readonly<Record<string, string>>)[expected];
  return compatible !== undefined && compatible.includes(actual);
}

export function protectedConfusableEquivalent(
  actual: string | undefined,
  expected: string,
): boolean {
  return actual !== undefined && protectedDirectConfusableEquivalent(actual, expected);
}

function isEquivalentToAny(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  for (const candidate of expected) {
    if (protectedConfusableEquivalent(actual, candidate)) return true;
  }
  return false;
}

function isProtectedBoundary(character: string | undefined): boolean {
  return character === undefined || (
    character !== "_"
    && !UNICODE_IDENTIFIER_UNIT_PATTERN.test(character)
    && !isEquivalentToAny(character, PROTECTED_ALPHANUMERIC_CLASSES)
  );
}

function skipMarks(characters: readonly string[], start: number): number {
  let cursor = start;
  while (UNICODE_MARK_PATTERN.test(characters[cursor] ?? "")) cursor += 1;
  return cursor;
}

function protectedPrefixEnd(
  characters: readonly string[],
  start: number,
  expected: string,
): number | null {
  if (!isProtectedBoundary(characters[start - 1])) return null;
  let cursor = skipMarks(characters, start);
  for (const expectedCharacter of expected) {
    if (!protectedConfusableEquivalent(characters[cursor], expectedCharacter)) return null;
    cursor = skipMarks(characters, cursor + 1);
  }
  return cursor;
}

function protectedBodyEnd(
  characters: readonly string[],
  start: number,
  bodyPunctuation: string,
): number | null {
  let cursor = skipMarks(characters, start);
  let consumed = false;
  let lastWasAlphanumeric = false;
  while (cursor < characters.length) {
    const character = characters[cursor];
    if (isEquivalentToAny(character, PROTECTED_ALPHANUMERIC_CLASSES)) {
      consumed = true;
      lastWasAlphanumeric = true;
    } else if (isEquivalentToAny(character, bodyPunctuation)) {
      consumed = true;
      lastWasAlphanumeric = false;
    } else {
      break;
    }
    cursor = skipMarks(characters, cursor + 1);
  }
  return consumed && lastWasAlphanumeric && isProtectedBoundary(characters[cursor])
    ? cursor
    : null;
}

function containsProtectedNamedIdentifier(characters: readonly string[]): boolean {
  for (let start = 0; start < characters.length; start += 1) {
    for (const identifier of PROTECTED_NAMED_IDENTIFIERS) {
      const prefixEnd = protectedPrefixEnd(characters, start, identifier.prefix);
      if (
        prefixEnd === null
        || !protectedConfusableEquivalent(characters[prefixEnd], identifier.separator)
      ) {
        continue;
      }
      const bodyStart = skipMarks(characters, prefixEnd + 1);
      if (protectedBodyEnd(characters, bodyStart, identifier.bodyPunctuation) !== null) return true;
    }
  }
  return false;
}

function containsProtectedDigest(characters: readonly string[]): boolean {
  for (let start = 0; start < characters.length; start += 1) {
    if (!isProtectedBoundary(characters[start - 1])) continue;
    let cursor = start;
    let hexSlots = 0;
    let markSlots = 0;
    while (cursor < characters.length) {
      const character = characters[cursor];
      if (isEquivalentToAny(character, PROTECTED_HEX_CLASSES)) {
        hexSlots += 1;
      } else if (UNICODE_MARK_PATTERN.test(character ?? "")) {
        markSlots += 1;
      } else {
        break;
      }
      cursor += 1;
    }
    const protectedLength = hexSlots >= 64
      || markSlots > 0 && hexSlots > 0 && hexSlots + markSlots >= 64;
    if (protectedLength && isProtectedBoundary(characters[cursor])) return true;
  }
  return false;
}

export function containsIntakeDisallowedFormatting(value: unknown): boolean {
  return typeof value === "string"
    && (BIDI_PATTERN.test(value) || ZERO_WIDTH_PATTERN.test(value) || CONTROL_PATTERN.test(value));
}

export function protectedConfusableDataIdentity(): typeof CONFUSABLE_DATA_IDENTITY {
  return CONFUSABLE_DATA_IDENTITY;
}

export function containsProtectedIdentifierShape(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const characters = Array.from(value.normalize("NFD"));
  return containsProtectedNamedIdentifier(characters) || containsProtectedDigest(characters);
}

export interface IntakeTextOptions {
  readonly maximum?: number;
  readonly allowNewlines?: boolean;
  readonly forbidAbsolutePath?: boolean;
  readonly forbidProtectedIdentifier?: boolean;
  readonly allowEmpty?: boolean;
  readonly allowDigest?: boolean;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function validateIntakeText(
  value: unknown,
  root: IntakeDiagnosticRoot,
  options: IntakeTextOptions = {},
): string {
  const maximum = options.maximum ?? INTAKE_LIMITS.text;
  const minimum = options.allowEmpty === true ? 0 : 1;
  if (typeof value !== "string") refuseIntake("intake.input.invalid", root);
  if (value.length < minimum || value.length > maximum) {
    refuseIntake("intake.text.too-long", root, { limit: maximum });
  }
  if (hasUnpairedSurrogate(value)) refuseIntake("intake.text.malformed-unicode", root);
  if (value !== value.normalize("NFC")) refuseIntake("intake.text.normalization", root);
  if (BIDI_PATTERN.test(value)) refuseIntake("intake.text.bidi", root);
  if (ZERO_WIDTH_PATTERN.test(value)) refuseIntake("intake.text.zero-width", root);
  if (CONTROL_PATTERN.test(value) || options.allowNewlines === false && /[\r\n]/u.test(value)) {
    refuseIntake("intake.text.control", root);
  }
  if (containsIntakeSecretShape(value, options)) {
    refuseIntake("intake.text.secret", root);
  }
  if (options.forbidAbsolutePath === true && containsAbsoluteLocalPath(value)) {
    refuseIntake("intake.text.absolute-path", root);
  }
  if (
    options.forbidProtectedIdentifier === true
    && containsProtectedIdentifierShape(value)
  ) {
    refuseIntake("intake.input.invalid", root);
  }
  return value;
}

export function validateDigest(value: unknown, root: IntakeDiagnosticRoot): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    refuseIntake("intake.input.invalid", root);
  }
  return value;
}

export function validateSafeInteger(
  value: unknown,
  root: IntakeDiagnosticRoot,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    refuseIntake("intake.input.invalid", root);
  }
  return value as number;
}

export type IntakeRecord = Readonly<Record<string, unknown>>;

export function intakeRecord(value: unknown, root: IntakeDiagnosticRoot): IntakeRecord {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return refuseIntake("intake.input.invalid", root);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return refuseIntake("intake.input.invalid", root);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return refuseIntake("intake.input.invalid", root);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (["__proto__", "constructor", "prototype"].some((key) => Object.hasOwn(descriptors, key))) {
      return refuseIntake("intake.input.invalid", root);
    }
    for (const descriptor of Object.values(descriptors)) {
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        return refuseIntake("intake.input.invalid", root);
      }
    }
    return Object.freeze(Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, (descriptor as PropertyDescriptor & { value: unknown }).value]),
    ));
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    return refuseIntake("intake.input.invalid", root);
  }
}

export function exactIntakeKeys(
  record: IntakeRecord,
  expected: readonly string[],
  root: IntakeDiagnosticRoot,
): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    refuseIntake("intake.input.invalid", root);
  }
  if (actual.some((key) => key === "__proto__" || key === "constructor" || key === "prototype")) {
    refuseIntake("intake.input.invalid", root);
  }
}

export function intakeArray<T>(
  value: unknown,
  root: IntakeDiagnosticRoot,
  parse: (item: unknown, index: number) => T,
  maximum: number = INTAKE_LIMITS.collection,
): readonly T[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return refuseIntake("intake.input.invalid", root);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = value.length;
    if (length > maximum) refuseIntake("intake.collection.too-large", root, { limit: maximum });
    if (Object.getOwnPropertySymbols(value).length !== 0 || Object.keys(descriptors).length !== length + 1) {
      return refuseIntake("intake.input.invalid", root);
    }
    const output: T[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        return refuseIntake("intake.input.invalid", root);
      }
      output.push(parse(descriptor.value, index));
    }
    return Object.freeze(output);
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    return refuseIntake("intake.input.invalid", root);
  }
}

export function semanticIntakeKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-GB")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replaceAll(/\s+/gu, " ");
}

export function mapProjectRefusal(error: unknown, root: IntakeDiagnosticRoot): never {
  if (error instanceof IntakeError) throw error;
  if (error instanceof ProjectContractError) {
    return refuseIntake("intake.project.refused", root, {
      projectCode: error.code,
      projectPath: error.path,
    });
  }
  return refuseIntake("intake.project.refused", root);
}

function inspectJsonString(text: string, start: number): { readonly value: string; readonly next: number } {
  let index = start + 1;
  let escaped = false;
  while (index < text.length) {
    const character = text[index];
    if (!escaped && character === '"') {
      try {
        return { value: JSON.parse(text.slice(start, index + 1)) as string, next: index + 1 };
      } catch {
        return refuseIntake("intake.input.invalid", "input");
      }
    }
    escaped = !escaped && character === "\\";
    if (character !== "\\") escaped = false;
    index += 1;
  }
  return refuseIntake("intake.input.invalid", "input");
}

function rejectDuplicateJsonKeys(text: string): void {
  let cursor = 0;
  let nodes = 0;
  const whitespace = (): void => {
    while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
  };
  const value = (depth: number): void => {
    nodes += 1;
    if (depth > 64 || nodes > 100_000) refuseIntake("intake.collection.too-large", "input");
    whitespace();
    const current = text[cursor];
    if (current === "{") { object(depth); return; }
    if (current === "[") { array(depth); return; }
    if (current === '"') { cursor = inspectJsonString(text, cursor).next; return; }
    while (cursor < text.length && !/[\s,\]}]/u.test(text[cursor] ?? "")) cursor += 1;
  };
  const object = (depth: number): void => {
    cursor += 1;
    whitespace();
    const keys = new Set<string>();
    if (text[cursor] === "}") { cursor += 1; return; }
    while (cursor < text.length) {
      whitespace();
      if (text[cursor] !== '"') return;
      const parsed = inspectJsonString(text, cursor);
      if (keys.has(parsed.value)) refuseIntake("intake.input.invalid", "input");
      keys.add(parsed.value);
      cursor = parsed.next;
      whitespace();
      if (text[cursor] !== ":") return;
      cursor += 1;
      value(depth + 1);
      whitespace();
      if (text[cursor] === "}") { cursor += 1; return; }
      if (text[cursor] !== ",") return;
      cursor += 1;
    }
  };
  const array = (depth: number): void => {
    cursor += 1;
    whitespace();
    if (text[cursor] === "]") { cursor += 1; return; }
    while (cursor < text.length) {
      value(depth + 1);
      whitespace();
      if (text[cursor] === "]") { cursor += 1; return; }
      if (text[cursor] !== ",") return;
      cursor += 1;
    }
  };
  value(0);
}

/** JSON boundary helper used when an intake caller receives text rather than an object. */
export function parseIntakeJsonText(text: unknown): unknown {
  if (typeof text !== "string" || text.length === 0 || text.length > 10_000_000) {
    return refuseIntake("intake.input.invalid", "input");
  }
  try {
    JSON.parse(text);
  } catch {
    return refuseIntake("intake.input.invalid", "input");
  }
  rejectDuplicateJsonKeys(text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return refuseIntake("intake.input.invalid", "input");
  }
}

export function isIntakeDiagnosticRoot(value: unknown): value is IntakeDiagnosticRoot {
  return typeof value === "string" && (INTAKE_DIAGNOSTIC_ROOTS as readonly string[]).includes(value);
}
