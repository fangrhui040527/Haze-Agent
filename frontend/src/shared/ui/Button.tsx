import type { ButtonHTMLAttributes } from 'react';
import styles from './ui.module.css';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'secondary' | 'primary' | 'ghost' | 'danger';
  size?: 'md' | 'small';
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    variant !== 'secondary' ? styles[variant] : '',
    size === 'small' ? styles.small : '',
    className ?? '',
  ].join(' ');
  return <button type={type} className={classes} {...rest} />;
}

/** Class names for a <Link> that should look like a button. */
export function buttonClass(
  variant: ButtonProps['variant'] = 'secondary',
  size: ButtonProps['size'] = 'md',
): string {
  return [
    styles.button,
    variant !== 'secondary' ? styles[variant] : '',
    size === 'small' ? styles.small : '',
  ].join(' ');
}
