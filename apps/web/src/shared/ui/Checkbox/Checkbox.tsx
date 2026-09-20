import { type ComponentPropsWithRef } from "react";
type Props = Omit<ComponentPropsWithRef<"input">, "type">;

export const Checkbox = (props: Props) => {
  return (
    <input type="checkbox" {...props} />
  );
};
