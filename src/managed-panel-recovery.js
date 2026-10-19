// Only create a replacement management panel when Discord confirms that the
// previously stored message is gone. Other errors can be transient or due to
// missing permissions, and must not create duplicate panels.
export function discordPanelMessageMissing(error) {
  return String(error?.code ?? error?.rawError?.code ?? '') === '10008' || Number(error?.status) === 404;
}
