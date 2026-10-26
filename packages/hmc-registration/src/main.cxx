// ANTs for WebAssembly: argv as the ANTs command lines take them, NIfTI images, MATLAB and text
// transforms, one ITK thread so results do not depend on the host.
//
// The first argument selects the program:
//   AverageImages ...           ANTs AverageImages (Examples/AverageImages.cxx)
//   AverageAffineTransform ...  ANTs AverageAffineTransform (Examples/AverageAffineTransform.cxx)
//   --apply ...                 legacy resampling through transforms (src/apply.cxx)
//   antsApplyTransforms ...     full native apply CLI, including MultiLabel and HDF5
//   ImageMath 3 out Laplacian... pinned 3D Laplacian operation only
//   anything else               antsRegistration
#include <algorithm>
#include <iostream>
#include <string>
#include <vector>
#include "AverageAffineTransform.h"
#include "AverageImages.h"
#include "antsRegistration.h"
#include "antsApplyTransforms.h"
#include "itkHDF5TransformIOFactory.h"
#include "itkMatlabTransformIOFactory.h"
#include "itkMultiThreaderBase.h"
#include "itkNiftiImageIOFactory.h"
#include "itkTxtTransformIOFactory.h"

int applyTransforms(int argc, char* argv[]);
int laplacianImage(int argc, char* argv[]);

int main(int argc, char* argv[]) {
  // One kernel instance runs main() many times (callMain), and ITK keeps every statically linked
  // factory it is given, duplicates included (ObjectFactoryBase::RegisterFactoryInternal). Register
  // the IO factories in the first run only (#537).
  static const bool registered = [] {
    itk::NiftiImageIOFactory::RegisterOneFactory();
    itk::MatlabTransformIOFactory::RegisterOneFactory();
    itk::HDF5TransformIOFactory::RegisterOneFactory();
    itk::TxtTransformIOFactory::RegisterOneFactory();
    return true;
  }();
  (void)registered;
  itk::MultiThreaderBase::SetGlobalDefaultNumberOfThreads(1);
  itk::MultiThreaderBase::SetGlobalDefaultThreader(itk::MultiThreaderBase::ThreaderEnum::Platform);
  try {
    const std::string program = argc > 1 ? argv[1] : "";
    // The ANTs entry points take the arguments without the program name, as their command lines do.
    const std::vector<std::string> rest(argv + std::min(argc, 2), argv + argc);
    if (program == "--apply") return applyTransforms(argc, argv);
    if (program == "ImageMath") return laplacianImage(argc - 1, argv + 1);
    if (program == "antsApplyTransforms") return ants::antsApplyTransforms(rest, nullptr);
    if (program == "AverageImages") return ants::AverageImages(rest, nullptr);
    if (program == "AverageAffineTransform") return ants::AverageAffineTransform(rest, nullptr);
    return ants::antsRegistration(std::vector<std::string>(argv + 1, argv + argc), nullptr);
  } catch (const std::exception& e) {
    std::cerr << e.what() << std::endl;
    return 1;
  }
}
