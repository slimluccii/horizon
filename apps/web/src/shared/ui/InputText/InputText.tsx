import { type ComponentPropsWithRef } from "react";
import clsx from "clsx";
import './InputText.css';

type Props = Omit<ComponentPropsWithRef<"input">, "type">;

export const InputText = ({ className, ...rest }: Props) => {
  return (
    <input className={clsx('input-text', className)} {...rest} />
  );
};
