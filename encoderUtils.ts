import { type Address } from "viem";

// Build operation encoder
export function encodeBuildOperation(
    functionSignature: string,
    args: any[],
    to: string,
    chainId: number,
    value: string,
) {
    return {
        type: "/instructions/build",
        data: {
            functionSignature,
            args,
            to,
            chainId,
            value,
            gasLimit: 1200000n.toString()
        },
    };
}

// Encode swap operation
export function encodeSwapOperation(
    srcToken: Address,
    dstToken: Address,
    srcChainId: number,
    dstChainId: number,
    amount: string,
    slippage: number = 0.01,
    allowSwapProviders?: string
) {
    return {
        type: "/instructions/intent-simple",
        data: {
            srcToken,
            dstToken,
            srcChainId,
            dstChainId,
            amount,
            slippage,
            ...(allowSwapProviders && { allowSwapProviders })
        },
    };
}