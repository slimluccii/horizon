import { type ComponentPropsWithRef } from "react";
type Props = Omit<ComponentPropsWithRef<"input">, "type">;

export const Radio = (props: Props) => {
  return (
    <input type="radio" {...props} />
  );
};
