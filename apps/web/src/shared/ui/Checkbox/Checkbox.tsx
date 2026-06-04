import { type ComponentPropsWithRef } from "react";
import clsx from "clsx";
import './Checkbox.css';

type Props = Omit<ComponentPropsWithRef<"input">, "type">;

export const Checkbox = ({ className, ...rest }: Props) => {
  return (
    <input type="checkbox" className={clsx('checkbox', className)} {...rest} />
  );
};
