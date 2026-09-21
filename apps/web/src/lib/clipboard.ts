/**
 * Copy text — `navigator.clipboard` exists only in secure contexts, so on
 * plain-http LAN rehearsals we fall back to a temporary readonly input +
 * execCommand('copy'). Resolves true when the copy probably worked.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the execCommand path
  }
  const el = document.createElement('input');
  el.value = text;
  el.readOnly = true;
  el.style.position = 'fixed';
  el.style.opacity = '0';
  document.body.appendChild(el);
  el.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    el.remove();
  }
}
