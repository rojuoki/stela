"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

interface ReturnToHandlerProps {
  onReturnTo: (returnTo: string) => void;
}

export function ReturnToHandler({ onReturnTo }: ReturnToHandlerProps) {
  const searchParams = useSearchParams();
  const returnTo = searchParams.get('returnTo') || '/';
  
  useEffect(() => {
    onReturnTo(returnTo);
  }, [returnTo, onReturnTo]);
  
  return null;
}