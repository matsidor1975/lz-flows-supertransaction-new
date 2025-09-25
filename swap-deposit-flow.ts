import { parseUnits, pad, concat, numberToHex, encodeAbiParameters, parseAbiParameters, type Address, createWalletClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { encodeBuildOperation, encodeSwapOperation } from './encoderUtils';

// Constants
const usrOft = "0x35e5db674d8e93a03d814fa0ada70731efe8a4b9";
const composer = "0x4ad165d7902b292d46b442ce2a4a25d5a891dd9d";
const apiKey = "mee_HyAhKoEgRJLxW6QrMasGW";
const meeApiUrl = 'https://api.biconomy.io/v1/instructions/compose';

// LayerZero endpoint IDs
const eidBase = 30184;
const eidEthereum = 30101;

// Token constants
const usrDecimals = 18;
const ethDecimals = 18;

// Transaction constants
const lzTokenFee = "0";
const emptyBytes = "0x";

const usdcBase = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const wstUsrOft = "0xb67675158b412d53fe6b68946483ba920b135ba1"; // wstUSR on Base



// USR deposit operation with runtime balance - FIXED VERSION
function encodeUsrDepositOperationWithRuntimeBalance(
    userAddress: Address,
    totalFeeInEth: string // Pass as ETH string like "0.005"
) {
    const totalFeeWei = parseUnits(totalFeeInEth, 18);

    // Use runtime balance without constraints to avoid failures
    const runtimeBalance = {
        type: 'runtimeErc20Balance',
        tokenAddress: usrOft
    };

    // Realistic gas estimates for Base -> Ethereum -> Base
    const lzReceiveGas = 200000;   // Standard for receive + compose queuing
    const composeGas = 800000;     // Vault deposit + share transfer back
    const nativeValueForReturn = parseUnits("0.0005", 18); // Small return message fee

    const options = concat([
        '0x0003',                                    // TYPE_3
        '0x01',                                      // EXECUTOR_WORKER_ID
        '0x0011',                                    // option_size: 17 bytes
        '0x01',                                      // OPTION_TYPE_LZRECEIVE
        pad(numberToHex(100000), { size: 16 })      // 100k gas for basic receive
    ]);

    // FIX: Use a non-zero placeholder that the composer will update
    // This avoids the zero-amount refund issue identified in audit
    const placeholderShareAmount = parseUnits("1", 18); // Non-zero placeholder
    const minShareAmountLD = 1n; // Minimal slippage protection

    // Correct SendParam structure for VaultComposerSync
    const composeMsg = encodeAbiParameters(
        parseAbiParameters('(uint32,bytes32,uint256,uint256,bytes,bytes,bytes),uint256'),
        [[
            eidBase,                           // Return to Base
            pad(userAddress, { size: 32 }),   // Final recipient
            placeholderShareAmount,            // FIX: Non-zero placeholder (was 0n before)
            minShareAmountLD,                 // Min shares to receive
            '0x',                              // Empty extraOptions for return trip
            '0x',                              // Empty composeMsg for return
            '0x'                               // Empty oftCmd
        ],
            nativeValueForReturn               // Native value for return message
        ]
    );

    return encodeBuildOperation(
        "function send((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress)",
        [
            [
                eidEthereum,                   // To Ethereum hub
                pad(composer, { size: 32 }),   // VaultComposerSync address
                runtimeBalance,                // All available USR
                parseUnits('0.5', usrDecimals).toString(),                 // Min 1 wei USR to send
                options,                       // Gas configuration
                composeMsg,                    // Return instructions with non-zero placeholder
                '0x'                           // No OFT commands
            ],
            [totalFeeWei.toString(), "0"],    // Fee in wei
            userAddress                        // Refund address
        ],
        usrOft,
        base.id,
        totalFeeWei.toString()  // FIXED: Use the calculated fee, not a hardcoded value
    );
}



// Transfer full balance operation
function encodeTransferFullBalance(
    tokenAddress: Address,
    recipientAddress: Address,
    chainId: number
) {
    const runtimeBalance = {
        type: 'runtimeErc20Balance',
        tokenAddress: tokenAddress
    };

    return encodeBuildOperation(
        "function transfer(address to, uint256 amount)",
        [
            recipientAddress,
            runtimeBalance
        ],
        tokenAddress,
        chainId,
        "0"
    );
}

// Calculate total fee for cross-chain operation - REALISTIC AMOUNTS
function calculateCrossChainFee(): { totalEth: string, breakdown: object } {
    // Realistic estimates for Base → Ethereum → Base operation

    // 1. LayerZero message fee (Base → Ethereum)
    const lzMessageFee = parseUnits("0.0003", 18); // ~$1.2 at $4000/ETH

    // 2. Ethereum execution gas costs at reasonable gas prices
    // lzReceive: 200k gas @ 15 gwei = 0.003 ETH
    // lzCompose: 400k gas @ 15 gwei = 0.006 ETH
    const ethereumGasCost = parseUnits("0.009", 18); // 0.009 ETH total

    // 3. Return message fee (Ethereum → Base)
    const returnMessageFee = parseUnits("0.0005", 18); // Included in options

    // Note: returnMessageFee is already included in the composeMsg as nativeValueForReturn
    // So we don't need to add it to the total here
    const subtotal = lzMessageFee + ethereumGasCost;
    const buffer = subtotal / 10n; // 10% buffer
    const total = subtotal + buffer;

    return {
        totalEth: "0.001", // Should be ~0.0105 ETH (~$42)
        breakdown: {
            lzMessageFee: formatUnits(lzMessageFee, 18),
            ethereumGasCost: formatUnits(ethereumGasCost, 18),
            returnMessageFee: formatUnits(returnMessageFee, 18),
            buffer: formatUnits(buffer, 18),
            total: formatUnits(total, 18)
        }
    };
}

// Compose multiple operations
async function composeInstructions(
    ownerAddress: Address,
    operations: any[],
    mode: "smart-account" | "eoa" | "eoa-7702" = "eoa"
) {
    const response = await fetch(meeApiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': apiKey
        },
        body: JSON.stringify({
            ownerAddress,
            mode,
            composeFlows: operations
        })
    });

    return response.json();
}

// Swap USDC to USR and deposit all USR to vault
async function buildSwapDepositAndTransferShares(
    userAddress: Address,
    recipientEoa: Address,
    usdcAmount: string,
) {
    // Calculate proper fee for the cross-chain operation
    const { totalEth, breakdown } = calculateCrossChainFee();

    console.log("Fee breakdown:", breakdown);

    const operations = [
        // 1. Swap USDC to USR on Base
        encodeSwapOperation(
            usdcBase,
            usrOft,
            base.id,
            base.id,
            usdcAmount,
            0.01,
        ),

        // 2. Deposit all USR to vault (receive wstUSR on Base)
        encodeUsrDepositOperationWithRuntimeBalance(userAddress, totalEth),

        // 3. Optional: Transfer all wstUSR shares to EOA
        // Uncomment if you want to transfer shares to a different address
        // encodeTransferFullBalance(
        //     wstUsrOft,
        //     recipientEoa,
        //     base.id
        // )
    ];

    return composeInstructions(userAddress, operations);
}

// Main execution
async function main() {
    const privKey = '0xaa1bc9458b85e247eecfe383283a4a797114edcfc2b5c8417e640ce04deddc62'
    const eoa = privateKeyToAccount(privKey)
    console.log(`EOA: ${eoa.address}`)

    const walletClient = createWalletClient({
        transport: http(),
        chain: base,
        account: eoa
    })

    const inputAmount = parseUnits('1', 6) // 1 USDC

    // Build the swap and deposit operations
    const composeResponse = await buildSwapDepositAndTransferShares(
        eoa.address,
        eoa.address,
        inputAmount.toString()
    ) as any;

    if (composeResponse.error) {
        console.error("Compose error:", composeResponse.error);
        return;
    }

    const nowInSeconds = Math.floor(Date.now() / 1000);

    // Get quote from Biconomy
    const quoteResponse = await fetch('https://api.biconomy.io/v1/mee/quote', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': apiKey
        },
        body: JSON.stringify({
            mode: 'eoa',
            ownerAddress: eoa.address,
            instructions: composeResponse.instructions,
            fundingTokens: [{
                tokenAddress: usdcBase,
                chainId: base.id,
                amount: inputAmount.toString()
            }],
            upperBoundTimestamp: nowInSeconds + 61,
            lowerBoundTimestamp: nowInSeconds,
            feeToken: {
                address: usdcBase,
                chainId: base.id
            }
        })
    });

    const quoteJSON = await quoteResponse.json() as any;

    if (quoteJSON.error) {
        console.error("Quote error details:", JSON.stringify(quoteJSON, null, 2));
        return;
    }

    const { payloadToSign } = quoteJSON

    // Sign the payload
    const signature = await walletClient.signTypedData({
        ...payloadToSign[0].signablePayload,
    });

    const execBody = {
        ...quoteJSON,
        payloadToSign: [{
            ...payloadToSign[0],
            signature: signature
        }]
    }

    console.log("Execution body:", JSON.stringify(execBody, null, 2))

    // Execute the transaction
    const response = await fetch('https://api.biconomy.io/v1/mee/execute', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': apiKey
        },
        body: JSON.stringify(execBody)
    });

    const data = await response.json() as any;
    console.log("Execution result:", data);

    if (data.error) {
        console.error("Execution error details:", JSON.stringify(data, null, 2));
    } 
}

// Run the main function
main().catch(console.error);