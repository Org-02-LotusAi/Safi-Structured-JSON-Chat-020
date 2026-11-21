import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const badgeVariants = cva('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold', {
  variants: {
    tone: {
      neutral: 'bg-bg text-muted ring-1 ring-line',
      ok: 'bg-ok-bg text-ok',
      bad: 'bg-bad-bg text-bad',
      warn: 'bg-warn-bg text-warn',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
