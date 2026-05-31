import { ComponentPropsWithRef } from "react";
import './Button.css';

type Props = ComponentPropsWithRef<"button">;

export const Button = ({ className, ...rest }: Props) => {
  return (
    <button className={`button${className ? ` ${className}` : ''}`} {...rest} />
  );
};
