import { type ComponentPropsWithRef } from "react";
import clsx from "clsx";
import './Radio.css';

type Props = Omit<ComponentPropsWithRef<"input">, "type">;

export const Radio = ({ className, ...rest }: Props) => {
  return (
    <input type="radio" className={clsx('radio', className)} {...rest} />
  );
};
