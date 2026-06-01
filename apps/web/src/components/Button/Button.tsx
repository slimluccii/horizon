import { type ComponentPropsWithRef } from "react";
import clsx from "clsx";
import './Button.css';

type Props = ComponentPropsWithRef<"button">;

export const Button = ({ type = 'button', className, ...rest }: Props) => {
  return (
    <button {...rest} type={type} className={clsx('button', className)} />
  );
};
