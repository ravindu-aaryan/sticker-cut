import { useRef, useState, type ReactNode } from 'react';

interface Props {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  children: ReactNode;
  compact?: boolean;
}

export function Dropzone({ onFiles, multiple = true, children, compact }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const accept = (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  };
  return (
    <div
      className={`dropzone${over ? ' over' : ''}${compact ? ' compact' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); accept(e.dataTransfer.files); }}
    >
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple={multiple}
        hidden
        onChange={(e) => { accept(e.target.files); e.target.value = ''; }}
      />
      {children}
    </div>
  );
}
