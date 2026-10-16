/** Lightweight script checks. Page/track language hints take precedence over
 * ambiguous Han-only strings; Japanese kanji are not proof of Chinese. */
export function isTargetLanguage(text: string, target = "zh", sourceLanguageHint?: string): boolean {
  const language = target.toLowerCase().split(/[-_]/)[0];
  const hint = sourceLanguageHint?.toLowerCase().split(/[-_]/)[0];
  if (hint && hint !== "auto" && hint !== "und" && hint !== language) return false;
  if (language === "zh") {
    if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) return false;
    const letters = text.match(/\p{L}/gu) ?? [];
    if (!letters.length) return false;
    const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
    // Mixed Chinese prose commonly contains product names and short acronyms.
    return han > 0 && han / letters.length >= 0.55;
  }
  if (hint === language) return true;
  if (language === "ja") return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
  if (language === "ko") return /\p{Script=Hangul}/u.test(text);
  return false;
}

export function shouldTranslateText(text: string, target = "zh", sourceLanguageHint?: string): boolean {
  const value = text.trim();
  return !!value && /\p{L}/u.test(value) && !isTargetLanguage(value, target, sourceLanguageHint);
}
