import { useEffect, useState, type JSX } from 'react';
import { useT } from '../../../../shared/i18n/I18nProvider';

/** The two device names to pick in Meet/Teams/Zoom, in a monospace, copyable box. */
export function CallDeviceNames({
  mic, speaker, heading,
}: {
  mic: string;
  speaker: string;
  heading: string;
}): JSX.Element {
  const t = useT();
  return (
    <div className="device-names">
      <div className="device-names__heading">{heading}</div>
      <DeviceNameRow label={t('trouble.guides.micLabel')} value={mic} />
      <DeviceNameRow label={t('trouble.guides.speakerLabel')} value={speaker} />
    </div>
  );
}

function DeviceNameRow({ label, value }: { label: string; value: string }): JSX.Element {
  const t = useT();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return (): void => window.clearTimeout(id);
  }, [copied]);

  const copy = (): void => {
    // Clipboard may be unavailable (window not focused, permission); the name stays
    // selectable in the box either way, so failure is only logged.
    navigator.clipboard?.writeText(value)
      .then(() => setCopied(true))
      .catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[setup] clipboard write failed', e);
      });
  };

  return (
    <div className="device-names__row">
      <span className="device-names__label">{label}</span>
      <code className="device-names__value">{value}</code>
      <button type="button" className="btn btn-ghost device-names__copy" onClick={copy}>
        {copied ? t('common.copied') : t('common.copy')}
      </button>
    </div>
  );
}
