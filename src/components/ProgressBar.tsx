import { formatPercent } from '../utils/format';
import { cn } from '../utils/cn';

export function ProgressBar({
  value,
  indeterminate = false,
  label,
  className,
}: {
  /** 0..1 */
  value: number;
  indeterminate?: boolean;
  label?: string;
  className?: string;
}) {
  const percent = formatPercent(value * 100);
  return (
    <div
      className={cn('progress-track', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : percent}
      aria-label={label ?? 'Transfer progress'}
    >
      <div
        className="progress-fill"
        style={{ width: `${indeterminate ? 40 : percent}%` }}
        data-indeterminate={indeterminate ? 'true' : 'false'}
      />
    </div>
  );
}
