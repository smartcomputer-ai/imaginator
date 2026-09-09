import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'text-foreground',
        muted: 'border-transparent bg-muted text-muted-foreground',
        green: 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        blue: 'border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300',
        red: 'border-transparent bg-red-500/15 text-red-700 dark:text-red-300',
        amber: 'border-transparent bg-amber-500/20 text-amber-800 dark:text-amber-300',
        orange: 'border-transparent bg-orange-500/20 text-orange-800 dark:text-orange-300',
        violet: 'border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
