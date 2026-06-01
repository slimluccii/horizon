import { type ComponentPropsWithRef } from "react";
import clsx from "clsx";
import './TextArea.css';

type Props = ComponentPropsWithRef<"textarea">;

export const TextArea = ({ className, ...rest }: Props) => {
  return (
    <textarea className={clsx('textarea', className)} {...rest} />
  );
};
