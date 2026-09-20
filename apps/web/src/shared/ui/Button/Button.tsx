import { type ComponentPropsWithRef } from "react";
type Props = ComponentPropsWithRef<"button">;

export const Button = ({ type = 'button', ...rest }: Props) => {
  return (
    <button {...rest} type={type} />
  );
};
