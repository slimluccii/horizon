import { type ComponentPropsWithRef } from "react";
type Props = ComponentPropsWithRef<"select">;

export const Select = (props: Props) => {
  return (
    <select {...props} />
  );
};
