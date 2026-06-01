import { type ComponentPropsWithRef } from "react";
import clsx from "clsx";
import './Label.css';

type Props = ComponentPropsWithRef<"label">;

export const Label = ({ className, ...rest }: Props) => {
  return (
    <label className={clsx('label', className)} {...rest} />
  );
};
