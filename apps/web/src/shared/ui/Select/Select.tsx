import { type ComponentPropsWithRef } from "react";
import clsx from "clsx";
import './Select.css';

type Props = ComponentPropsWithRef<"select">;

export const Select = ({ className, ...rest }: Props) => {
  return (
    <select className={clsx('select', className)} {...rest} />
  );
};
