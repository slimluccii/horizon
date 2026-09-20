import { type ComponentPropsWithRef } from "react";
type Props = ComponentPropsWithRef<"textarea">;

export const TextArea = (props: Props) => {
  return (
    <textarea {...props} />
  );
};
