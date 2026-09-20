import { type ComponentPropsWithRef } from "react";
type Props = Omit<ComponentPropsWithRef<"input">, "type">;

export const InputText = (props: Props) => {
  return (
    <input {...props} />
  );
};
