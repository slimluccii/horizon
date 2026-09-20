import { type ComponentPropsWithRef } from "react";
type Props = ComponentPropsWithRef<"label">;

export const Label = (props: Props) => {
  return (
    <label {...props} />
  );
};
