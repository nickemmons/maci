import * as path from 'path'
import { Circuit } from 'snarkjs'
const compiler = require('circom')
import {
    setupTree,
    genRandomSalt,
    Plaintext,
    bigInt,
    hashOne,
    hash,
    SnarkBigInt,
} from 'maci-crypto'

import {
    compileAndLoadCircuit,
} from '../'

const ZERO_VALUE = 0

describe('Quadratic vote tallying circuit', () => {
    let circuit 

    beforeAll(async () => {
        circuit = await compileAndLoadCircuit('quadVoteTally_test.circom')
    })

    it('CalculateTotal should correctly sum a list of values', async () => {
        const circuitDef = await compiler(path.join(__dirname, 'circuits', '../../../circom/test/calculateTotal_test.circom'))
        const ctCircuit = new Circuit(circuitDef)

        const nums = [3, 3, 3, 3, 2, 4]
        const sum = nums.reduce((a, b) => a + b, 0)

        const circuitInputs = {
            nums,
        }

        const witness = ctCircuit.calculateWitness(circuitInputs)
        const resultIdx = ctCircuit.getSignalIdx('main.sum')
        const result = witness[resultIdx]
        expect(result.toString()).toEqual(sum.toString())
    })

    it('QuadVoteTally should correctly tally a set of votes', async () => {
        // as set in quadVoteTally_test.circom
        const fullStateTreeDepth = 4
        const intermediateStateTreeDepth = 2
        const voteOptionTreeDepth = 3
        const messageLength = 5
        const numUsers = 2 ** intermediateStateTreeDepth
        const numVoteOptions = 2 ** voteOptionTreeDepth

        // The depth at which the intermediate state tree leaves exist in the full state tree
        const k = fullStateTreeDepth - intermediateStateTreeDepth

        // The batch #
        for (let intermediatePathIndex = 0; intermediatePathIndex < 2 ** k; intermediatePathIndex ++) {
            const salt = genRandomSalt()
            const currentResultsSalt = genRandomSalt()

            // Generate sample votes
            let voteLeaves: SnarkBigInt[] = []
            for (let i = 0; i < 2 ** fullStateTreeDepth; i++) {
                const votes: SnarkBigInt[] = []
                for (let j = 0; j < numVoteOptions; j++) {
                    votes.push(bigInt(Math.round(Math.random() * 10)))
                }
                voteLeaves.push(votes)
            }

            const fullStateTree = setupTree(fullStateTreeDepth, ZERO_VALUE)

            let rawStateLeaves: Plaintext[] = []
            let voteOptionTrees = []

            // Populate the state tree
            for (let i = 0; i < 2 ** fullStateTreeDepth; i++) {

                // Insert the vote option leaves to calculate the voteOptionRoot
                const voteOptionMT = setupTree(voteOptionTreeDepth, ZERO_VALUE)

                for (let j = 0; j < voteLeaves[i].length; j++) {
                    voteOptionMT.insert(voteLeaves[i][j])
                }

                const rawStateLeaf = [0, 0, voteOptionMT.root, 0, 0]
                rawStateLeaves.push(rawStateLeaf)

                // Insert the state leaf
                fullStateTree.insert(hash(rawStateLeaf))
            }

            // The leaves of the intermediate state tree (which are the roots of each batch)
            let intermediateLeaves: SnarkBigInt[] = []
            const batchSize = 2 ** intermediateStateTreeDepth

            // Compute the Merkle proof for the batch
            const intermediateStateTree = setupTree(k, ZERO_VALUE)

            // For each batch, create a tree of the leaves in the batch, and insert the
            // tree root into another tree
            for (let i = 0; i < fullStateTree.leaves.length; i += batchSize) {
                const tree = setupTree(intermediateStateTreeDepth, ZERO_VALUE)
                for (let j = 0; j < batchSize; j++) {
                    tree.insert(fullStateTree.leaves[i + j])
                }
                intermediateLeaves.push(tree.root)

                intermediateStateTree.insert(tree.root)
            }

            const intermediatePathElements = intermediateStateTree.getPathUpdate(intermediatePathIndex)[0]

            // Set inputs
            let circuitInputs = {
                intermediatePathElements,
            }

            for (let i = 0; i < batchSize; i++) {
                for (let j = 0; j < numVoteOptions; j++) {
                    circuitInputs['voteLeaves[' + i + '][' + j + ']'] = 
                        voteLeaves[intermediatePathIndex * batchSize + i][j].toString()
                }

                for (let j = 0; j < messageLength; j++) {
                    circuitInputs['stateLeaves[' + i + '][' + j + ']'] =
                        rawStateLeaves[intermediatePathIndex * batchSize + i][j].toString()
                }
            }

            // Calculate the commitment to the current results
            let currentResults: SnarkBigInt[] = []
            for (let i = 0; i < numVoteOptions; i++) {
                currentResults.push(bigInt(0))
            }

            for (let i = 0; i < intermediatePathIndex * batchSize; i++) {
                for (let j = 0; j < numVoteOptions; j++) {
                    currentResults[j] += voteLeaves[i][j]
                }
            }

            const currentResultsCommitment = hash([...currentResults, currentResultsSalt])

            circuitInputs['currentResults'] = currentResults
            circuitInputs['fullStateRoot'] = fullStateTree.root.toString()
            circuitInputs['intermediateStateRoot'] = intermediateStateTree.leaves[intermediatePathIndex].toString()
            circuitInputs['intermediatePathIndex'] = intermediatePathIndex.toString()
            circuitInputs['newResultsSalt'] = salt.toString()
            circuitInputs['currentResultsSalt'] = currentResultsSalt.toString()
            circuitInputs['currentResultsCommitment'] = currentResultsCommitment.toString()

            const witness = circuit.calculateWitness(circuitInputs)

            let expected: SnarkBigInt[] = []
            for (let i = 0; i < numVoteOptions; i++) {

                let subtotal = currentResults[i]
                for (let j = 0; j < batchSize; j++){
                    if (j === 0 && intermediatePathIndex === 0) {
                        continue
                    }
                    subtotal += voteLeaves[intermediatePathIndex * batchSize + j][i]
                }

                expected.push(subtotal)
            }

            const result = witness[circuit.getSignalIdx('main.newResultsCommitment')]
            const expectedCommitment = hash([...expected, salt])
            expect(result.toString()).toEqual(expectedCommitment.toString())
        }
    })
})
