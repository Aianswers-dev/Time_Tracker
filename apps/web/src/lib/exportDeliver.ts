/**
 * Getting an export file off the phone. iOS handles files best through the
 * share sheet (Save to Files, AirDrop, Mail), so the Web Share API is used when
 * it accepts files; anywhere else, a Blob URL and a download link.
 */

export function canShareFile(file: File): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
    return false;
  }
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export type ShareOutcome = 'shared' | 'cancelled' | 'needs-tap';

/**
 * Open the share sheet for `file`. Safari only allows it during a user tap; if
 * building the file took long enough for the tap to expire, the result is
 * 'needs-tap' and the caller offers a second tap.
 */
export async function shareFile(file: File): Promise<ShareOutcome> {
  try {
    await navigator.share({ files: [file], title: file.name });
    return 'shared';
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
    if (err instanceof DOMException && err.name === 'NotAllowedError') return 'needs-tap';
    throw err;
  }
}

/** Start a download of an object URL by clicking a temporary link. */
export function clickDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
