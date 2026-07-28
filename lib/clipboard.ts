/** Port of the MVP's copy() helper. */
export async function copyText(
  text: string,
  onDone: (message: string) => void,
  successMessage = "نُسخ",
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    onDone(successMessage);
  } catch {
    onDone("تعذّر النسخ");
  }
}
